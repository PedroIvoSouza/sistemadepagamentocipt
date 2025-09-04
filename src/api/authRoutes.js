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
  const { email, nome_empresa } = req.body || {};
  if (!cnpjNum) {
    return res.status(400).json({ error: 'O CNPJ é obrigatório.' });
  }

  const sql = `SELECT * FROM permissionarios WHERE ${SQL_MATCH_CNPJ}`;
  db.all(sql, [cnpjNum], async (err, users = []) => {
    if (err) {
      console.error('[solicitar-acesso] DB error:', err);
      return res.status(500).json({ error: 'Erro interno do servidor.' });
    }

    // Resposta idempotente para não vazar existência do CNPJ
    if (!users.length) {

      return res.status(200).json({
        message: 'Se um CNPJ correspondente for encontrado, um e-mail será enviado.',
        permissionarioId: null
      });
    }

    let user = users[0];
    if (users.length > 1) {
      if (!email && !nome_empresa) {
        return res.status(400).json({
          error: 'Email ou nome da empresa são obrigatórios para este CNPJ.'
        });
      }
      if (email) {
        user = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
      } else if (nome_empresa) {
        user = users.find(
          (u) => String(u.nome_empresa).toLowerCase() === String(nome_empresa).toLowerCase()
        );
      }
      if (!user) {
        return res.status(400).json({
          error: 'Permissionário não encontrado com os dados fornecidos.'
        });
      }
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutos

    try {
      for (const user of users) {
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedCodigo = await bcrypt.hash(codigo, 10);
        const updateSql = `
          UPDATE permissionarios
          SET senha_reset_token = ?, senha_reset_expires = ?
          WHERE id = ?
        `;
        await new Promise((resolve, reject) =>
          db.run(updateSql, [hashedCodigo, expires, user.id], (uErr) =>
            uErr ? reject(uErr) : resolve()
          )
        );

        try {
          await enviarEmailRedefinicao(user.email, codigo);
        } catch (mailErr) {
          console.error('[solicitar-acesso] email error:', mailErr);
        }
      }

      return res.status(200).json({
        message: 'Se um CNPJ correspondente for encontrado, um e-mail será enviado.',
        permissionarioId: user.id
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
  const { codigo, permissionarioId } = req.body || {};

  if (!cnpjNum || !codigo || !permissionarioId) {
    return res
      .status(400)
      .json({ error: 'CNPJ, código e permissionarioId são obrigatórios.' });
  }

  const sql = `
    SELECT * FROM permissionarios
    WHERE ${SQL_MATCH_CNPJ} AND senha_reset_expires > ?
  `;
  db.all(sql, [cnpjNum, Date.now()], async (err, users = []) => {
    if (err) {
      console.error('[verificar-codigo] DB error:', err);
      return res.status(500).json({ error: 'Erro de banco de dados.' });
    }

    const user = users.find((u) => u.id === Number(permissionarioId));
    if (!user) {
      return res.status(400).json({
        error: 'Código inválido, expirado ou dados incorretos. Tente novamente.'
      });
    }

    try {
      // Compara o código fornecido com o token armazenado para o permissionário
      const match = await bcrypt.compare(codigo, user.senha_reset_token || '');
      if (!match) {
        return res.status(400).json({
          error: 'Código inválido, expirado ou dados incorretos. Tente novamente.'
        });
      }

      // Código válido: gera token temporário para redefinição de senha
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
    const { cnpj, login, senha, email, nome_empresa } = req.body || {};
    const cnpjNum = normalizeCnpj(cnpj || login);

    if (!cnpjNum || !senha) {
      return res.status(400).json({ error: 'CNPJ e senha são obrigatórios.' });
    }

    const sql = `
      SELECT * FROM permissionarios
      WHERE ${SQL_MATCH_CNPJ}
    `;

    db.all(sql, [cnpjNum], async (err, users = []) => {
      if (err) {
        console.error('[login] DB error:', err);
        return res.status(500).json({ error: 'Erro de banco de dados.' });
      }
      if (!users.length) {
        return res.status(401).json({ error: 'Credenciais inválidas.' });
      }

      let user = users[0];
      if (users.length > 1) {
        if (!email && !nome_empresa) {
          return res.status(400).json({
            error: 'Email ou nome da empresa são obrigatórios para este CNPJ.'
          });
        }
        if (email) {
          user = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
        } else if (nome_empresa) {
          user = users.find(
            (u) => String(u.nome_empresa).toLowerCase() === String(nome_empresa).toLowerCase()
          );
        }
        if (!user) {
          return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
      }

      if (!user.senha) {
        return res.status(401).json({
          error: 'Usuário não possui senha cadastrada. Por favor, use o "Primeiro Acesso".'
        });
      }

      return res.status(401).json({ error: 'Credenciais inválidas.' });
    });
  } catch (e) {
    console.error('[login] unexpected:', e);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
