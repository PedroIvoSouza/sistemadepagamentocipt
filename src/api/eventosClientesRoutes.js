// src/api/eventosClientesRoutes.js
// Normaliza/valida CPF/CNPJ e corrige POST (sem tipoNormalizado), PF/PJ coerente com CHECK('PF','PJ')

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { enviarEmailDefinirSenha } = require('../services/emailService');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const adminRouter = express.Router();
const publicRouter = express.Router();
const clientRouter = express.Router();

const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

const SALT_ROUNDS = 10;

// Utils
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const isCpf = d => !!d && d.length === 11;
const isCnpj = d => !!d && d.length === 14;

// PF/PJ para o CHECK da tabela (aceita entradas variadas e devolve 'PF' | 'PJ')
const normalizeTipoPessoa = (v = '') => {
  const s = String(v).trim().toUpperCase();
  if (['PF', 'FISICA', 'FÍSICA', 'PESSOA FISICA', 'PESSOA FÍSICA'].includes(s)) return 'PF';
  if (['PJ', 'JURIDICA', 'JURÍDICA', 'PESSOA JURIDICA', 'PESSOA JURÍDICA'].includes(s)) return 'PJ';
  return '';
};

/* ===================================================================
   ROTAS DO CLIENTE LOGADO (PORTAL DE EVENTOS) – exigem CLIENTE_EVENTO
   =================================================================== */
clientRouter.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO']));

clientRouter.get('/me', async (req, res) => {
  const clienteId = req.user.id;
  try {
    const fetchUser = new Promise((resolve, reject) => {
      const sql = `SELECT * FROM Clientes_Eventos WHERE id = ?`;
      db.get(sql, [clienteId], (err, row) => err ? reject(err) : resolve(row));
    });

    const fetchEventos = new Promise((resolve, reject) => {
      const sql = `SELECT * FROM Eventos WHERE id_cliente = ? ORDER BY id DESC`;
      db.all(sql, [clienteId], (err, rows) => err ? reject(err) : resolve(rows));
    });

    const fetchDars = new Promise((resolve, reject) => {
      const sql = `
        SELECT d.*, de.id_evento, de.numero_parcela, de.valor_parcela
        FROM dars d
        JOIN DARs_Eventos de ON de.id_dar = d.id
        JOIN Eventos e ON e.id = de.id_evento
        WHERE e.id_cliente = ?
        ORDER BY d.data_vencimento DESC, d.id DESC
      `;
      db.all(sql, [clienteId], (err, rows) => err ? reject(err) : resolve(rows));
    });

    const [user, eventos, dars] = await Promise.all([fetchUser, fetchEventos, fetchDars]);
    if (!user) return res.status(404).json({ error: 'Cliente não encontrado.' });

    delete user.senha_hash;
    delete user.token_definir_senha;

    res.json({ user, eventos, dars });
  } catch (err) {
    console.error('[CLIENTE-EVENTO]/me erro:', err);
    return res.status(500).json({ error: 'Erro interno ao buscar os dados do cliente.' });
  }
});

clientRouter.put('/me', (req, res) => {
  const clienteId = req.user.id;
  const {
    telefone, nomeResponsavel, cep, logradouro, numero, bairro, cidade, uf, complemento
  } = req.body;

  const enderecoCompleto = (
    `${logradouro || ''}, ${numero || ''}` +
    `${complemento ? ' ' + complemento : ''} - ` +
    `${bairro || ''}, ${cidade || ''} - ${(uf || '').toUpperCase()}, ${cep || ''}`
  ).replace(/\s+/g, ' ').trim();

  const sql = `
    UPDATE Clientes_Eventos SET
      telefone = ?, nome_responsavel = ?, cep = ?, logradouro = ?, 
      numero = ?, bairro = ?, cidade = ?, uf = ?, endereco = ?, complemento = ?
    WHERE id = ?
  `;
  const params = [
    onlyDigits(telefone || ''), nomeResponsavel || null, onlyDigits(cep || ''), logradouro || null,
    (numero ?? '').toString(), bairro || null, cidade || null, (uf || '').toUpperCase(),
    enderecoCompleto || null, complemento || null, clienteId
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error('[CLIENTE-EVENTO]/me UPDATE erro:', err.message);
      return res.status(500).json({ error: 'Erro ao atualizar o cliente no banco de dados.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
    return res.json({ message: 'Cliente atualizado com sucesso.', id: clienteId });
  });
});

clientRouter.post('/change-password', (req, res) => {
  const clienteId = req.user.id;
  const { senha_atual, nova_senha, confirmar_nova_senha } = req.body;

  if (!senha_atual || !nova_senha || !confirmar_nova_senha) {
    return res.status(400).json({ error: 'Todos os campos de senha são obrigatórios.' });
  }
  if (nova_senha !== confirmar_nova_senha) {
    return res.status(400).json({ error: 'As novas senhas não coincidem.' });
  }

  db.get(`SELECT senha_hash FROM Clientes_Eventos WHERE id = ?`, [clienteId], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const match = await bcrypt.compare(senha_atual, user.senha_hash || '');
    if (!match) return res.status(401).json({ error: 'A senha atual está incorreta.' });

    const novaSenhaHash = await bcrypt.hash(nova_senha, SALT_ROUNDS);
    db.run(`UPDATE Clientes_Eventos SET senha_hash = ? WHERE id = ?`, [novaSenhaHash, clienteId], (err2) => {
      if (err2) {
        console.error('[CLIENTE-EVENTO]/change-password erro:', err2.message);
        return res.status(500).json({ error: 'Erro ao atualizar a senha.' });
      }
      res.json({ message: 'Senha alterada com sucesso!' });
    });
  });
});

/* ===================================================================
   ROTAS PÚBLICAS (Login/Definir Senha) — sem token
   =================================================================== */

publicRouter.post('/definir-senha', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha) return res.status(400).json({ error: 'Token e senha são obrigatórios.' });

  const sql = `SELECT id FROM Clientes_Eventos WHERE token_definir_senha = ?`;
  db.get(sql, [token], async (err, cliente) => {
    if (err) return res.status(500).json({ error: 'Erro interno no servidor.' });
    if (!cliente) return res.status(404).json({ error: 'Token inválido ou já utilizado.' });

    try {
      const senha_hash = await bcrypt.hash(senha, SALT_ROUNDS);
      const updateSql = `UPDATE Clientes_Eventos SET senha_hash = ?, token_definir_senha = NULL WHERE id = ?`;
      db.run(updateSql, [senha_hash, cliente.id], function (err2) {
        if (err2) return res.status(500).json({ error: 'Não foi possível atualizar a senha.' });
        res.json({ message: 'Senha definida com sucesso!' });
      });
    } catch (hashError) {
      res.status(500).json({ error: 'Erro interno ao processar a senha.' });
    }
  });
});

publicRouter.get('/definir-senha/validar', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ ok: false, error: 'Token ausente.' });

  const sql = `SELECT id, nome_razao_social FROM Clientes_Eventos WHERE token_definir_senha = ?`;
  db.get(sql, [token], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: 'Erro interno.' });
    if (!row) return res.status(404).json({ ok: false, error: 'Token inválido ou já utilizado.' });
    res.json({ ok: true, cliente: { id: row.id, nome: row.nome_razao_social } });
  });
});

publicRouter.post('/login', (req, res) => {
  const { login, senha } = req.body;
  if (!login || !senha) {
    return res.status(400).json({ error: 'Login e senha são obrigatórios.' });
  }

  const sql = `SELECT id, nome_razao_social, email, senha_hash FROM Clientes_Eventos WHERE email = ? OR documento = ?`;
  db.get(sql, [login, onlyDigits(login)], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
    if (!row || !row.senha_hash) {
      return res.status(401).json({ error: 'Credenciais inválidas ou cadastro não finalizado.' });
    }

    const ok = await bcrypt.compare(senha, row.senha_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const payload = { id: row.id, nome: row.nome_razao_social, role: 'CLIENTE_EVENTO' };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ message: 'Login realizado com sucesso!', token });
  });
});

/* ===================================================================
   ROTAS DE ADMIN (Gerenciamento) – exigem ADMIN
   =================================================================== */
adminRouter.use(adminAuthMiddleware);

// LISTAR
adminRouter.get('/', (req, res) => {
  const sql = `SELECT * FROM Clientes_Eventos ORDER BY nome_razao_social`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro interno no servidor.' });
    res.json(rows);
  });
});

// CRIAR (corrigido: sem tipoNormalizado, PF/PJ correto, endereço e token)
adminRouter.post('/', async (req, res) => {
  let {
    nome_razao_social, tipo_pessoa, documento, email, telefone,
    nome_responsavel, tipo_cliente, documento_responsavel,
    cep, logradouro, numero, complemento, bairro, cidade, uf
  } = req.body || {};

  const tp = normalizeTipoPessoa(tipo_pessoa);
  if (!nome_razao_social || !tp || !documento || !email || !tipo_cliente) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  documento = onlyDigits(documento);
  const docOk = (tp === 'PF' && isCpf(documento)) || (tp === 'PJ' && isCnpj(documento));
  if (!docOk) {
    return res.status(400).json({ error: 'Documento inválido (CPF/CNPJ).' });
  }

  const telDigits = onlyDigits(telefone || '');
  const docRespDigits = tp === 'PJ' ? onlyDigits(documento_responsavel || '') : null;
  const nomeResp = tp === 'PJ' ? (nome_responsavel || null) : null;

  const enderecoCompleto = (
    `${logradouro || ''}, ${numero || ''}` +
    `${complemento ? ' ' + complemento : ''} - ` +
    `${bairro || ''}, ${cidade || ''} - ${(uf || '').toUpperCase()}, ${onlyDigits(cep || '')}`
  ).replace(/\s+/g, ' ').trim();

  try {
    const token = crypto.randomBytes(32).toString('hex');

    const sql = `INSERT INTO Clientes_Eventos (
      nome_razao_social, tipo_pessoa, documento, email, telefone,
      nome_responsavel, tipo_cliente, token_definir_senha, documento_responsavel,
      cep, logradouro, numero, complemento, bairro, cidade, uf, endereco
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const params = [
      String(nome_razao_social).trim(), tp, documento, String(email).trim(),
      telDigits || null, nomeResp, String(tipo_cliente).trim(), token, docRespDigits,
      onlyDigits(cep || ''), logradouro || null, (numero ?? '').toString(), complemento || null,
      bairro || null, cidade || null, (uf || '').toUpperCase(), enderecoCompleto || null
    ];

    db.run(sql, params, async function (err) {
      if (err) {
        console.error('[ADMIN EVENTOS CLIENTES][POST] SQL erro:', err.message, '| params:', params);
        if (String(err.message).includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'Já existe um cliente com este CPF/CNPJ.' });
        }
        return res.status(500).json({ error: 'Erro ao salvar o cliente no banco de dados.' });
      }

      try {
        await enviarEmailDefinirSenha(email, nome_razao_social, token);
        res.status(201).json({ id: this.lastID, message: 'Cliente criado com sucesso. E-mail para definição de senha enviado.' });
      } catch (emailError) {
        console.error('[ADMIN EVENTOS CLIENTES][POST] E-mail falhou:', emailError?.message);
        res.status(201).json({ id: this.lastID, message: 'Cliente criado, mas houve falha ao enviar o e-mail de definição de senha.' });
      }
    });
  } catch (error) {
    console.error('[ADMIN EVENTOS CLIENTES][POST] Erro inesperado:', error);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// ATUALIZAR
adminRouter.put('/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const tp = normalizeTipoPessoa(body.tipo_pessoa);
  const safe = {
    nome_razao_social    : (body.nome_razao_social ?? body.nome ?? '').trim(),
    tipo_pessoa          : tp,
    documento            : onlyDigits(body.documento ?? ''),
    email                : (body.email ?? '').trim(),
    telefone             : onlyDigits(body.telefone ?? ''),
    nome_responsavel     : tp === 'PJ' ? (body.nome_responsavel ?? '').trim() : null,
    tipo_cliente         : (body.tipo_cliente ?? 'Geral').trim(),
    documento_responsavel: tp === 'PJ' ? onlyDigits(body.documento_responsavel ?? '') : null,
    cep                  : onlyDigits(body.cep ?? ''),
    logradouro           : (body.logradouro ?? '').trim(),
    numero               : (body.numero ?? '').toString().trim(),
    complemento          : (body.complemento ?? '').trim(),
    bairro               : (body.bairro ?? '').trim(),
    cidade               : (body.cidade ?? '').trim(),
    uf                   : (body.uf ?? '').toString().trim().toUpperCase().slice(0, 2),
  };

  if (!safe.nome_razao_social || !safe.tipo_pessoa || !safe.documento || !safe.email || !safe.tipo_cliente) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  const docOk = (safe.tipo_pessoa === 'PF' && isCpf(safe.documento)) ||
                (safe.tipo_pessoa === 'PJ' && isCnpj(safe.documento));
  if (!docOk) return res.status(400).json({ error: 'Documento inválido (CPF/CNPJ).' });

  const enderecoCompleto = (
    `${safe.logradouro || ''}, ${safe.numero || ''}` +
    `${safe.complemento ? ' ' + safe.complemento : ''} - ` +
    `${safe.bairro || ''}, ${safe.cidade || ''} - ${safe.uf || ''}, ${safe.cep || ''}`
  ).replace(/\s+/g, ' ').trim();

  const sql = `
    UPDATE Clientes_Eventos SET
      nome_razao_social = ?, tipo_pessoa = ?, documento = ?, email = ?,
      telefone = ?, nome_responsavel = ?, tipo_cliente = ?, documento_responsavel = ?,
      cep = ?, logradouro = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, endereco = ?
    WHERE id = ?
  `;
  const params = [
    safe.nome_razao_social, safe.tipo_pessoa, safe.documento, safe.email,
    safe.telefone || null, safe.nome_responsavel, safe.tipo_cliente, safe.documento_responsavel,
    safe.cep, safe.logradouro || null, safe.numero, safe.complemento || null, safe.bairro || null,
    safe.cidade || null, safe.uf, enderecoCompleto || null, id
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error('[EVENTOS-CLIENTES][UPDATE] ERRO SQLite:', err.message);
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'Já existe um cliente com este CPF/CNPJ.' });
      }
      if (err.message.includes('CHECK constraint failed')) {
        return res.status(400).json({ error: "Valor inválido para 'tipo_pessoa'. Use 'PF' ou 'PJ'." });
      }
      return res.status(500).json({ error: 'Erro ao atualizar o cliente no banco de dados.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
    }
    res.json({ message: 'Cliente atualizado com sucesso.', id });
  });
});

module.exports = {
  adminRoutes: adminRouter,
  publicRoutes: publicRouter,
  clientRoutes: clientRouter
};
