// src/api/botRoutes.js
// Rotas usadas EXCLUSIVAMENTE pelo bot do WhatsApp para consultar/entregar DARs.
// - GET /api/bot/dars?msisdn=55XXXXXXXXXXX
// - GET /api/bot/dars/:darId/pdf?msisdn=55XXXXXXXXXXX
//
// Protegidas por middleware simples de shared-key (x-bot-key ou ?key=) -> src/middleware/botAuthMiddleware.js

require('dotenv').config();

const express   = require('express');
const sqlite3   = require('sqlite3').verbose();
const path      = require('path');
const fs        = require('fs');

const botAuthMiddleware = require('../middleware/botAuthMiddleware');

const router = express.Router();

// ---------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[BOT][DB] Falha ao abrir SQLite:', err.message);
  } else if (process.env.BOT_ROUTES_DEBUG === '1') {
    console.log('[BOT][DB] Conectado ao SQLite em:', dbPath);
  }
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const DEBUG = process.env.BOT_ROUTES_DEBUG === '1';

const digits = (s = '') => String(s).replace(/\D/g, '');
const last11 = (s = '') => {
  const d = digits(s);
  return d.length > 11 ? d.slice(-11) : d;
};

const isHttpUrl = (u = '') => /^https?:\/\//i.test(String(u || ''));

// "limpa" coluna de telefone dentro do SQL (SQLite não tem regex)
const sqlCleanPhone = (col) => `
REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''), '+',''), '(',''), ')',''), '-',''), ' ','')
`;

// Detecta se existe a coluna telefone_cobranca em permissionarios (com cache)
let hasTelCobrancaCache = null;
function detectTelCobranca() {
  return new Promise((resolve) => {
    if (hasTelCobrancaCache !== null) return resolve(hasTelCobrancaCache);
    db.all(`PRAGMA table_info(permissionarios)`, [], (err, rows = []) => {
      if (err) {
        console.warn('[BOT] PRAGMA table_info(permissionarios) falhou:', err.message);
        hasTelCobrancaCache = false;
        return resolve(false);
      }
      hasTelCobrancaCache = rows.some(r => (r.name || '').toLowerCase() === 'telefone_cobranca');
      if (DEBUG) console.log('[BOT] telefone_cobranca existe?', hasTelCobrancaCache);
      resolve(hasTelCobrancaCache);
    });
  });
}

// Promise helpers
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// ---------------------------------------------------------------------
// GET /api/bot/dars?msisdn=55XXXXXXXXXXX
// Retorna:
//  { ok: true, permissionario: {id, nome_empresa}, dars: { vigente: {...}|null, vencidas: [...] } }
// Observações:
//  - Procura o permissionário por telefone principal, e (se existir) telefone_cobranca
//  - "msisdn" pode vir com 55, sem 55, com símbolos; tudo normalizado
// ---------------------------------------------------------------------
router.get('/dars', botAuthMiddleware, async (req, res) => {
  try {
    const msisdnRaw = String(req.query.msisdn || '').trim();
    if (!msisdnRaw) return res.status(400).json({ error: 'Parâmetro msisdn é obrigatório.' });

    const wantedFull = digits(msisdnRaw);
    const wanted11   = last11(msisdnRaw);
    const hasCobr    = await detectTelCobranca();

    // Buscamos todos e comparamos em JS para tolerar quaisquer formatos pré-existentes
    const cols = hasCobr
      ? `id, nome_empresa, telefone, telefone_cobranca`
      : `id, nome_empresa, telefone`;

    if (DEBUG) console.log('[BOT]/dars msisdn=', msisdnRaw, 'wantedFull=', wantedFull, 'wanted11=', wanted11);

    let rows;
    try {
      rows = await allAsync(`SELECT ${cols} FROM permissionarios`, []);
    } catch (e) {
      console.error('[BOT][dars] erro SELECT permissionarios:', e.message);
      return res.status(500).json({ error: 'Erro ao consultar permissionários.' });
    }

    let found = null;
    for (const r of rows) {
      const cand = [digits(r.telefone || '')];
      if (hasCobr) cand.push(digits(r.telefone_cobranca || ''));

      // compara contra: full (com 55) e últimos 11
      if (cand.some(t => !!t && (t === wantedFull || t === wanted11 || last11(t) === wanted11))) {
        found = { id: r.id, nome_empresa: r.nome_empresa };
        break;
      }
    }

    if (!found) {
      if (DEBUG) console.log('[BOT]/dars NOT FOUND by phone');
      return res.status(404).json({ error: 'Telefone não associado a nenhum permissionário.' });
    }

    // DARs vencidas (pendentes com vencimento no passado)
    const sqlVencidas = `
      SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
        FROM dars
       WHERE permissionario_id = ?
         AND status = 'Pendente'
         AND DATE(data_vencimento) < DATE('now')
       ORDER BY DATE(data_vencimento) ASC, id ASC
    `;
    // DAR vigente (próxima pendente não vencida)
    const sqlVigente = `
      SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
        FROM dars
       WHERE permissionario_id = ?
         AND status = 'Pendente'
         AND DATE(data_vencimento) >= DATE('now')
       ORDER BY DATE(data_vencimento) ASC, id ASC
       LIMIT 1
    `;

    let vencidas = [];
    let vigente  = null;
    try {
      vencidas = await allAsync(sqlVencidas, [found.id]);
    } catch (e1) {
      console.error('[BOT][dars] erro SELECT vencidas:', e1.message);
      return res.status(500).json({ error: 'Erro ao consultar DARs vencidas.' });
    }
    try {
      vigente = await getAsync(sqlVigente, [found.id]);
    } catch (e2) {
      console.error('[BOT][dars] erro SELECT vigente:', e2.message);
      return res.status(500).json({ error: 'Erro ao consultar DAR vigente.' });
    }

    return res.json({
      ok: true,
      permissionario: found,
      dars: {
        vigente: vigente || null,
        vencidas
      }
    });
  } catch (err) {
    console.error('[BOT][dars] erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/bot/dars/:darId/pdf?msisdn=55XXXXXXXXXXX
// Regras:
//  - Confere se o DAR pertence a um permissionário cujo telefone (ou telefone_cobranca) bate com o msisdn.
//  - Se d.pdf_url for http/https -> redireciona
//  - Se for caminho relativo sob /public -> faz stream do arquivo
//  - Proteção contra path traversal
// ---------------------------------------------------------------------
router.get('/dars/:darId/pdf', botAuthMiddleware, async (req, res) => {
  const darId  = Number(req.params.darId);
  const msisdn = digits(req.query.msisdn);

  if (!darId || !msisdn) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  const alt11   = msisdn.startsWith('55') ? msisdn.slice(2) : msisdn;
  const hasCobr = await detectTelCobranca();

  // Monta a clause de telefone com/sem telefone_cobranca
  const clause = hasCobr
    ? `(${sqlCleanPhone('p.telefone')} IN (?, ?) OR ${sqlCleanPhone('p.telefone_cobranca')} IN (?, ?))`
    : `${sqlCleanPhone('p.telefone')} IN (?, ?)`;

  const sql = `
    SELECT d.id AS dar_id, d.pdf_url, d.permissionario_id
      FROM dars d
      JOIN permissionarios p ON p.id = d.permissionario_id
     WHERE d.id = ?
       AND ${clause}
     LIMIT 1
  `;
  const params = hasCobr
    ? [darId, msisdn, alt11, msisdn, alt11]
    : [darId, msisdn, alt11];

  if (DEBUG) {
    console.log('[BOT]/dars/:id/pdf darId=', darId, 'msisdn=', msisdn, 'alt11=', alt11, 'hasCobr=', hasCobr);
  }

  db.get(sql, params, (err, row) => {
    if (err) {
      console.error('[BOT][PDF] ERRO SQL:', err.message);
      return res.status(500).json({ error: 'Erro interno.' });
    }
    if (!row) {
      if (DEBUG) console.log('[BOT][PDF] DAR não encontrada p/ telefone');
      return res.status(404).json({ error: 'DAR não encontrada para este telefone.' });
    }
    if (!row.pdf_url) {
      if (DEBUG) console.log('[BOT][PDF] DAR sem pdf_url');
      return res.status(404).json({ error: 'DAR ainda não possui PDF gerado.' });
    }

    // URL absoluta? redireciona.
    if (isHttpUrl(row.pdf_url)) {
      return res.redirect(row.pdf_url);
    }

    // Caminho relativo sob /public
    const publicDir = path.join(__dirname, '..', '..', 'public');
    const rel = String(row.pdf_url).replace(/^\/+/, ''); // remove / inicial
    const abs = path.join(publicDir, rel);

    // Proteção simples contra path traversal
    if (!abs.startsWith(publicDir)) {
      console.warn('[BOT][PDF] Path traversal detectado:', row.pdf_url);
      return res.status(400).json({ error: 'Caminho inválido.' });
    }

    if (!fs.existsSync(abs)) {
      if (DEBUG) console.log('[BOT][PDF] Arquivo não encontrado em', abs);
      return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  });
});

// ---------------------------------------------------------------------
// Exporta router
// ---------------------------------------------------------------------
module.exports = router;

