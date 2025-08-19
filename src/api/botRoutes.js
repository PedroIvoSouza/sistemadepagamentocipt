// src/api/botRoutes.js
'use strict';
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const botAuthMiddleware = require('../middleware/botAuthMiddleware');

const router = express.Router();
// garante que req.body funcione mesmo se o app principal não tiver json/urlencoded
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// -------------------- DB --------------------
const defaultDbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(process.env.SQLITE_PATH || defaultDbPath);

// Evita SQLITE_BUSY em picos (se disponível nesta versão do sqlite3)
try { db.configure && db.configure('busyTimeout', 5000); } catch {}

// Garante colunas mínimas sem alterar esquema existente
db.serialize(() => {
  ensureColumn('dars', 'status', 'TEXT');
});

function ensureColumn(table, column, type) {
  db.all(`PRAGMA table_info(${table})`, (err, rows = []) => {
    if (err) return console.error('PRAGMA table_info failed:', err);
    if (!rows.some(r => r.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, e => {
        if (e) console.error(`ALTER TABLE ${table} ADD COLUMN ${column} failed:`, e);
      });
    }
  });
}

// -------------------- helpers --------------------
const digits = (s = '') => String(s).replace(/\D/g, '');
const last11 = (s = '') => {
  const d = digits(s);
  return d.length > 11 ? d.slice(-11) : d;
};

// Tenta casar msisdn contra uma lista de telefones em vários formatos
function phoneMatches(msisdn, phoneList = []) {
  const ms = digits(msisdn);
  const ms11 = last11(ms);
  const alt11 = ms.startsWith('55') ? ms.slice(2) : ms; // 55XXXXXXXXXXX -> XXXXXXXXXXX

  for (const raw of phoneList) {
    if (!raw) continue;
    const p = digits(raw);
    if (!p) continue;
    if (p === ms || p === alt11 || last11(p) === ms11) return true;
  }
  return false;
}

// Detecta se existe a coluna telefone_cobranca (permissionários)
let hasTelCobrancaCache = null;
function detectTelCobranca() {
  return new Promise((resolve) => {
    if (hasTelCobrancaCache !== null) return resolve(hasTelCobrancaCache);
    db.all(`PRAGMA table_info(permissionarios)`, [], (err, rows = []) => {
      if (err) { hasTelCobrancaCache = false; return resolve(false); }
      hasTelCobrancaCache = rows.some(r => (r.name || '').toLowerCase() === 'telefone_cobranca');
      resolve(hasTelCobrancaCache);
    });
  });
}

// Busca um permissionário por telefone (principal e, se existir, cobrança)
async function findPermissionarioByMsisdn(msisdn) {
  const hasCobr = await detectTelCobranca();
  const cols = hasCobr
    ? `id, nome_empresa, telefone, telefone_cobranca`
    : `id, nome_empresa, telefone`;

  return new Promise((resolve, reject) => {
    db.all(`SELECT ${cols} FROM permissionarios`, [], (e, rows = []) => {
      if (e) return reject(e);
      for (const r of rows) {
        const cand = [r.telefone];
        if (hasCobr) cand.push(r.telefone_cobranca);
        if (phoneMatches(msisdn, cand)) {
          return resolve({ id: r.id, nome: r.nome_empresa, tipo: 'PERMISSIONARIO' });
        }
      }
      resolve(null);
    });
  });
}

// Busca um cliente de eventos por telefone
function findClienteEventoByMsisdn(msisdn) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT id, nome_razao_social, telefone FROM Clientes_Eventos`;
    db.all(sql, [], (e, rows = []) => {
      if (e) return reject(e);
      for (const r of rows) {
        if (phoneMatches(msisdn, [r.telefone])) {
          return resolve({ id: r.id, nome: r.nome_razao_social, tipo: 'CLIENTE_EVENTO' });
        }
      }
      resolve(null);
    });
  });
}

// Lista DARs pendentes (vigente + vencidas) para permissionário
function listarDarsPermissionario(permissionarioId) {
  const sqlVencidas = `
    SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url, mes_referencia, ano_referencia
      FROM dars
      WHERE permissionario_id = ?
        AND status <> 'Pago'
        AND DATE(data_vencimento) < DATE('now')
      ORDER BY DATE(data_vencimento) ASC, id ASC;
  `;
  const sqlVigente = `
    SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url, mes_referencia, ano_referencia
      FROM dars
      WHERE permissionario_id = ?
        AND status <> 'Pago'
        AND DATE(data_vencimento) >= DATE('now')
      ORDER BY DATE(data_vencimento) ASC, id ASC
      LIMIT 1;
  `;
  return new Promise((resolve, reject) => {
    db.all(sqlVencidas, [permissionarioId], (e1, vencidas = []) => {
      if (e1) return reject(e1);
      db.get(sqlVigente, [permissionarioId], (e2, vigenteRow) => {
        if (e2) return reject(e2);
        resolve({ vigente: vigenteRow || null, vencidas });
      });
    });
  });
}

// Lista DARs pendentes para cliente de eventos (via join)
function listarDarsClienteEvento(clienteId) {
  const base = `
    SELECT d.id, d.valor, d.data_vencimento, d.status, d.numero_documento, d.linha_digitavel, d.pdf_url
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      JOIN Eventos e ON e.id = de.id_evento
     WHERE e.id_cliente = ?
       AND d.status <> 'Pago'
  `;
  const sqlVencidas = `${base} AND DATE(d.data_vencimento) < DATE('now')
                       ORDER BY DATE(d.data_vencimento) ASC, d.id ASC`;
  const sqlVigente = `${base} AND DATE(d.data_vencimento) >= DATE('now')
                      ORDER BY DATE(d.data_vencimento) ASC, d.id ASC
                      LIMIT 1`;
  return new Promise((resolve, reject) => {
    db.all(sqlVencidas, [clienteId], (e1, vencidas = []) => {
      if (e1) return reject(e1);
      db.get(sqlVigente, [clienteId], (e2, vigenteRow) => {
        if (e2) return reject(e2);
        resolve({ vigente: vigenteRow || null, vencidas });
      });
    });
  });
}

// Decide se um DAR é de permissionário ou de evento
function obterContextoDar(darId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT
        d.id,
        d.permissionario_id,
        e.id            AS evento_id,
        e.id_cliente    AS cliente_evento_id
      FROM dars d
      LEFT JOIN DARs_Eventos de ON de.id_dar = d.id
      LEFT JOIN Eventos e ON e.id = de.id_evento
     WHERE d.id = ?
     LIMIT 1
    `;
    db.get(sql, [darId], (e, row) => {
      if (e) return reject(e);
      if (!row) return resolve(null);
      if (row.cliente_evento_id) {
        return resolve({ tipo: 'CLIENTE_EVENTO', cliente_evento_id: row.cliente_evento_id, permissionario_id: null });
      }
      if (row.permissionario_id) {
        return resolve({ tipo: 'PERMISSIONARIO', permissionario_id: row.permissionario_id, cliente_evento_id: null });
      }
      // Se não caiu em nenhum, trate como desconhecido
      resolve({ tipo: 'DESCONHECIDO' });
    });
  });
}

function isDummyNumeroDocumento(s) {
  return typeof s === 'string' && /^DUMMY-\d+$/i.test(s);
}

// PDF gerado em memória (Promise)
function generateDarPdfBase64({ id, numero_documento, linha_digitavel, msisdn }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);

    doc.fontSize(16).text('DAR - Documento de Arrecadação', { align: 'left' }).moveDown();
    doc.fontSize(12).text(`DAR ID: ${id}`);
    doc.text(`Número do Documento: ${numero_documento || '-'}`);
    doc.text(`Linha Digitável: ${linha_digitavel || '-'}`);
    if (msisdn) doc.text(`MSISDN: ${msisdn}`);
    doc.moveDown().text('*** Documento gerado para consulta via BOT ***');
    doc.end();
  });
}

// -------------------- ROTAS --------------------

/**
 * GET /api/bot/dars?msisdn=55XXXXXXXXXXX
 * Se achar 1 conta, mantém resposta legada:
 *   { ok, permissionario: {id,nome_empresa}, dars:{vigente,vencidas} }
 * Se achar múltiplas contas (ex.: 1 perm + 1 evento), retorna:
 *   { ok, contas: [ { tipo:'PERMISSIONARIO'| 'CLIENTE_EVENTO', id, nome, dars:{...} }, ... ] }
 */
router.get('/dars', botAuthMiddleware, async (req, res) => {
  try {
    const msisdn = String(req.query.msisdn || '').trim();
    if (!msisdn) return res.status(400).json({ error: 'Parâmetro msisdn é obrigatório.' });

    const contas = [];

    // 1) permissionário
    const perm = await findPermissionarioByMsisdn(msisdn);
    if (perm) {
      const dars = await listarDarsPermissionario(perm.id);
      contas.push({ tipo: 'PERMISSIONARIO', id: perm.id, nome: perm.nome, dars });
    }

    // 2) cliente de eventos
    const cli = await findClienteEventoByMsisdn(msisdn);
    if (cli) {
      const dars = await listarDarsClienteEvento(cli.id);
      contas.push({ tipo: 'CLIENTE_EVENTO', id: cli.id, nome: cli.nome, dars });
    }

    if (contas.length === 0) {
      return res.status(404).json({ error: 'Telefone não associado a nenhum permissionário/cliente.' });
    }

    // Back-compat: se só tem 1 conta e ela for permissionário, mantém payload legado
    if (contas.length === 1 && contas[0].tipo === 'PERMISSIONARIO') {
      const { id, nome, dars } = contas[0];
      return res.json({ ok: true, permissionario: { id, nome_empresa: nome }, dars });
    }

    // Caso geral (um ou mais perfis)
    return res.json({ ok: true, contas });
  } catch (err) {
    console.error('[BOT][dars] erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

/**
 * GET /api/bot/dars/:darId/pdf?msisdn=55XXXXXXXXXXX
 * Retorna/encaminha o PDF, validando que o MSISDN é dono do DAR
 * (permissionário OU cliente de eventos).
 * Se não houver PDF salvo, gera um PDF simples "on-the-fly" (placeholder).
 */
router.get('/dars/:darId/pdf', botAuthMiddleware, async (req, res) => {
  try {
    const darId = Number(req.params.darId);
    const msisdn = String(req.query.msisdn || '').trim();
    if (!darId || !msisdn) return res.status(400).json({ error: 'Parâmetros inválidos.' });

    const hasCobr = await detectTelCobranca();
    const telCobrSelect = hasCobr ? ', p.telefone_cobranca AS tel_cob' : ', NULL AS tel_cob';

    const sql = `
      SELECT
        d.id        AS dar_id,
        d.pdf_url   AS pdf_url,
        d.numero_documento AS numero_documento,
        d.linha_digitavel  AS linha_digitavel,
        p.telefone  AS tel_perm
        ${telCobrSelect},
        ce.telefone AS tel_cli
      FROM dars d
      LEFT JOIN permissionarios p   ON p.id = d.permissionario_id
      LEFT JOIN DARs_Eventos de     ON de.id_dar = d.id
      LEFT JOIN Eventos e           ON e.id = de.id_evento
      LEFT JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
     WHERE d.id = ?
     LIMIT 1
    `;
    const row = await new Promise((resolve, reject) =>
      db.get(sql, [darId], (e, r) => (e ? reject(e) : resolve(r)))
    );
    if (!row) return res.status(404).json({ error: 'DAR não encontrada.' });

    // Checagem de posse por telefone
    if (!phoneMatches(msisdn, [row.tel_perm, row.tel_cob, row.tel_cli])) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a acessar este DAR.' });
    }

    // Se houver PDF salvo, devolve (base64/URL/arquivo)
    const savedPdf = row.pdf_url || '';
    if (savedPdf && String(savedPdf).length >= 20) {
      // 1) Base64 embutido?
      const isBase64 =
        /^JVBER/i.test(savedPdf) || /^data:application\/pdf;base64,/i.test(savedPdf);
      if (isBase64) {
        const base64 = String(savedPdf).replace(/^data:application\/pdf;base64,/i, '');
        const buf = Buffer.from(base64, 'base64');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
        return res.send(buf);
      }
      // 2) URL absoluta?
      if (/^https?:\/\//i.test(savedPdf)) {
        return res.redirect(302, savedPdf);
      }
      // 3) Caminho relativo (tenta UPLOADS_DIR; fallback /public)
      const rel = String(savedPdf).replace(/^\/+/, '');
      const upDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
      const pubDir = path.join(__dirname, '..', '..', 'public');
      const tryPaths = [path.join(upDir, rel), path.join(pubDir, rel)];
      const fsPath = tryPaths.find(p => fs.existsSync(p));
      if (!fsPath) {
        return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });
      }
      res.type('application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
      return fs.createReadStream(fsPath).pipe(res);
    }

    // Sem PDF salvo: gera placeholder on-the-fly
    const numero_documento =
      row.numero_documento && !isDummyNumeroDocumento(row.numero_documento)
        ? row.numero_documento
        : `DUMMY-${row.dar_id}`;
    const linha_digitavel =
      row.linha_digitavel ||
      '00000.00000 00000.000000 00000.000000 0 00000000000000';

    const pdfBase64 = await generateDarPdfBase64({
      id: row.dar_id,
      numero_documento,
      linha_digitavel,
      msisdn
    });
    const buf = Buffer.from(pdfBase64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
    return res.status(200).send(buf);
  } catch (err) {
    console.error('[BOT][PDF] erro:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

/**
 * POST /api/bot/dars/:darId/emit
 * Body (opcional): { msisdn: "55..." }  -> valida a posse antes de emitir.
 * Dispara a emissão (stub) e devolve metadados. O banco:
 *   - marca status = 'Emitido'
 *   - preenche linha_digitavel se estiver NULL
 *   - NÃO sobrescreve numero_documento real (usa COALESCE)
 */
router.post('/dars/:darId/emit', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);

  // aceita no body, query ou header (x-msisdn)
  const msisdnRaw = req.body?.msisdn ?? req.query?.msisdn ?? req.headers['x-msisdn'];
  const msisdn = msisdnRaw ? digits(String(msisdnRaw)) : null;

  if (!darId) return res.status(400).json({ error: 'Parâmetro darId inválido.' });

  try {
    // Se informaram msisdn, valida a posse
    if (msisdn) {
      const hasCobr = await detectTelCobranca();
      const checkSql = `
        SELECT
          p.telefone AS tel_perm,
          ${hasCobr ? 'p.telefone_cobranca AS tel_cob,' : 'NULL AS tel_cob,'}
          ce.telefone AS tel_cli
        FROM dars d
        LEFT JOIN permissionarios p ON p.id = d.permissionario_id
        LEFT JOIN DARs_Eventos de   ON de.id_dar = d.id
        LEFT JOIN Eventos e         ON e.id = de.id_evento
        LEFT JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
       WHERE d.id = ?
       LIMIT 1
      `;
      const row = await new Promise((resolve, reject) => {
        db.get(checkSql, [darId], (e, r) => e ? reject(e) : resolve(r));
      });
      if (!row) return res.status(404).json({ error: 'DAR não encontrada.' });
      if (!phoneMatches(msisdn, [row.tel_perm, row.tel_cob, row.tel_cli])) {
        return res.status(403).json({ error: 'Este telefone não está autorizado a emitir este DAR.' });
      }
    }

    const contexto = await obterContextoDar(darId);
    if (!contexto || contexto.tipo === 'DESCONHECIDO') {
      return res.status(404).json({ error: 'DAR não encontrada ou sem contexto.' });
    }

    // Emissão "stub" (mantém número real no banco; preenche se faltar)
    const meta = await emitirDarViaSefaz(darId, { msisdn }); // retorna { numero_documento, linha_digitavel, pdf_url }
    return res.json({ ok: true, darId, ...meta });
  } catch (err) {
    console.error('[BOT][EMIT] erro ao emitir DAR:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao emitir a DAR.' });
  }
});

/**
 * Implementação de fachada que NÃO sobrescreve numero_documento real.
 * - Se numero_documento for NULL, seta "DUMMY-{id}".
 * - Se já existir número real (ex.: 151358231), mantém.
 * - Preenche linha_digitavel se NULL.
 * - Sempre marca status='Emitido'.
 * - Gera um PDF base64 de retorno (não depende de persistência de arquivo).
 */
async function emitirDarViaSefaz(darId, { msisdn }) {
  // Busca dados atuais
  const row = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, numero_documento, linha_digitavel, pdf_url FROM dars WHERE id = ?`,
      [darId],
      (e, r) => (e ? reject(e) : resolve(r || {}))
    );
  });

  if (!row || !row.id) throw new Error('DAR não encontrada.');

  const numero_documento =
    row.numero_documento && !isDummyNumeroDocumento(row.numero_documento)
      ? row.numero_documento
      : `DUMMY-${darId}`;

  const linha_digitavel =
    row.linha_digitavel ||
    '00000.00000 00000.000000 00000.000000 0 00000000000000';

  // Atualiza status + completa campos sem sobrescrever número real
  await new Promise((resolve, reject) => {
    const sql = `
      UPDATE dars
         SET status           = 'Emitido',
             linha_digitavel  = COALESCE(linha_digitavel, ?),
             numero_documento = COALESCE(numero_documento, ?)
       WHERE id = ?`;
    db.run(sql, [linha_digitavel, numero_documento, darId], function (e) {
      if (e) return reject(e);
      resolve();
    });
  });

  // Gera PDF de retorno (aguardando o stream terminar)
  const pdfBase64 = await generateDarPdfBase64({
    id: darId,
    numero_documento,
    linha_digitavel,
    msisdn
  });

  return {
    numero_documento,
    linha_digitavel,
    pdf_url: pdfBase64 // seu GET já detecta base64 (JVBER…)
  };
}

module.exports = router;
