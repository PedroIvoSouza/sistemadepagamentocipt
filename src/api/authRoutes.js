const express = require('express');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { enviarEmailRedefinicao } = require('../services/emailService');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// Helpers
const normalizeCnpj = (v = '') => String(v).replace(/\D/g, '');
const SQL_MATCH_CNPJ = `
  REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
`;

// -----------------------------------------------------------------------------
// Rota 1: Usuário solicita o código de verificação (Primeiro Acesso / Esqueci)
// -----------------------------------------------------------------------------
router.post('/solicitar-acesso', (req, res) => {
  const cnpjNum = normalizeCnpj(req.body?.cnpj);
  if (!cnpjNum) {
    return res.status(400).json({ error: 'O CNPJ é obrigatório.' });
  }

  const sql = `SELECT * FROM permissionarios WHERE ${SQL_MATCH_CNPJ}`;
  db.get(sql, [cnpjNum], async (err, user) => {
    if (err) {
      console.error('[solicitar-acesso] DB error:', err);
      return res.status(500).json({ error: 'Erro interno do servidor.' });
    }

    // Resposta idempotente para não vazar existência do CNPJ
    if (!user) {
      return res.status(200).json({
        message: 'Se um CNPJ correspondente for encontrado, um e-mail será enviado.'
      });
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutos

    try {
      const hashedCodigo = await bcrypt.hash(codigo, 10);
      const updateSql = `
        UPDATE permissionarios
        SET senha_reset_token = ?, senha_reset_expires = ?
        WHERE id = ?
      `;
      db.run(updateSql, [hashedCodigo, expires, user.id], async (uErr) => {
        if (uErr) {
          console.error('[solicitar-acesso] update error:', uErr);
          return res.status(500).json({ error: 'Erro ao salvar o token de redefinição.' });
        }

        try {
          await enviarEmailRedefinicao(user.email, codigo);
        } catch (mailErr) {
          console.error('[solicitar-acesso] email error:', mailErr);
          // Ainda retornamos 200 para não vazar detalhes, mas logamos o erro.
        }

        return res.status(200).json({
          message: 'Se um CNPJ correspondente for encontrado, um e-mail será enviado.'
        });
      });
    } catch (hashErr) {
      console.error('[solicitar-acesso] hash error:', hashErr);
      return res.status(500).json({ error: 'Erro ao processar a solicitação.' });
    }
  });
});

// -----------------------------------------------------------------------------
// Rota 2: Usuário envia o código para verificação
// -----------------------------------------------------------------------------
router.post('/verificar-codigo', (req, res) => {
  const cnpjNum = normalizeCnpj(req.body?.cnpj);
  const { codigo } = req.body || {};

  if (!cnpjNum || !codigo) {
    return res.status(400).json({ error: 'CNPJ e código são obrigatórios.' });
  }

  const sql = `
    SELECT * FROM permissionarios
    WHERE ${SQL_MATCH_CNPJ} AND senha_reset_expires > ?
  `;
  db.get(sql, [cnpjNum, Date.now()], async (err, user) => {
    if (err) {
      console.error('[verificar-codigo] DB error:', err);
      return res.status(500).json({ error: 'Erro de banco de dados.' });
    }
    if (!user) {
      return res.status(400).json({
        error: 'Código inválido, expirado ou CNPJ incorreto. Tente novamente.'
      });
    }

    try {
      const match = await bcrypt.compare(codigo, user.senha_reset_token || '');
      if (!match) {
        return res.status(400).json({
          error: 'Código inválido, expirado ou CNPJ incorreto. Tente novamente.'
        });
      }

      const payload = { id: user.id, reset: true };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });

      return res.status(200).json({
        message: 'Código verificado com sucesso!',
        token
      });
    } catch (cmpErr) {
      console.error('[verificar-codigo] compare error:', cmpErr);
      return res.status(500).json({ error: 'Erro interno do servidor.' });
    }
  });
});

// -----------------------------------------------------------------------------
// Rota 3: Usuário define a nova senha (com token de permissão)
// -----------------------------------------------------------------------------
router.post('/definir-senha', (req, res) => {
  const { token, password, passwordConfirmation } = req.body || {};

  if (!token || !password || !passwordConfirmation) {
    return res.status(400).json({ error: 'Token e senhas são obrigatórios.' });
  }
  if (password !== passwordConfirmation) {
    return res.status(400).json({ error: 'As senhas não coincidem.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (vErr, decoded) => {
    if (vErr) {
      return res.status(403).json({
        error: 'Permissão inválida ou expirada. Por favor, reinicie o processo.'
      });
    }
    if (!decoded?.reset) {
      return res.status(403).json({ error: 'Permissão inválida.' });
    }

    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const userId = decoded.id;

      const updateSql = `
        UPDATE permissionarios
        SET senha = ?, senha_reset_token = NULL, senha_reset_expires = NULL
        WHERE id = ?
      `;
      db.run(updateSql, [hashedPassword, userId], (uErr) => {
        if (uErr) {
          console.error('[definir-senha] update error:', uErr);
          return res.status(500).json({ error: 'Não foi possível atualizar a senha.' });
        }
        return res.status(200).json({ message: 'Senha atualizada com sucesso!' });
      });
    } catch (hashErr) {
      console.error('[definir-senha] hash error:', hashErr);
      return res.status(500).json({ error: 'Erro de segurança ao processar a senha.' });
    }
  });
});

// -----------------------------------------------------------------------------
// Rota 4: Login normal (aceita { cnpj, senha } ou { login, senha })
// -----------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { cnpj, login, senha } = req.body || {};
    const cnpjNum = normalizeCnpj(cnpj || login);

    if (!cnpjNum || !senha) {
      return res.status(400).json({ error: 'CNPJ e senha são obrigatórios.' });
    }

    const sql = `
      SELECT * FROM permissionarios
      WHERE ${SQL_MATCH_CNPJ}
    `;

    db.get(sql, [cnpjNum], async (err, user) => {
      if (err) {
        console.error('[login] DB error:', err);
        return res.status(500).json({ error: 'Erro de banco de dados.' });
      }
      if (!user) {
        return res.status(401).json({ error: 'Credenciais inválidas.' });
      }
      if (!user.senha) {
        return res.status(401).json({
          error: 'Usuário não possui senha cadastrada. Por favor, use o "Primeiro Acesso".'
        });
      }

      const ok = await bcrypt.compare(senha, user.senha);
      if (!ok) {
        return res.status(401).json({ error: 'Credenciais inválidas.' });
      }

      const payload = { id: user.id, nome: user.nome_empresa };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

      return res.status(200).json({
        message: 'Login bem-sucedido!',
        token
      });
    });
  } catch (e) {
    console.error('[login] unexpected:', e);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
