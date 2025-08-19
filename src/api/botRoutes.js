// src/api/botRoutes.js
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const botAuthMiddleware = require('../middleware/botAuthMiddleware');

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// Evita SQLITE_BUSY em picos (se disponível nesta versão do sqlite3)
try { db.configure && db.configure('busyTimeout', 5000); } catch {}

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
  const cols = hasCobr ? `id, nome_empresa, telefone, telefone_cobranca` : `id, nome_empresa, telefone`;

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
    SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
      FROM dars
     WHERE permissionario_id = ?
       AND status = 'Pendente'
       AND DATE(data_vencimento) < DATE('now')
     ORDER BY DATE(data_vencimento) ASC, id ASC
  `;
  const sqlVigente = `
    SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
      FROM dars
     WHERE permissionario_id = ?
       AND status = 'Pendente'
       AND DATE(data_vencimento) >= DATE('now')
     ORDER BY DATE(data_vencimento) ASC, id ASC
     LIMIT 1
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
       AND d.status = 'Pendente'
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
 */
router.get('/dars/:darId/pdf', botAuthMiddleware, (req, res) => {
  const darId = Number(req.params.darId);
  const msisdn = digits(req.query.msisdn || '');
  if (!darId || !msisdn) return res.status(400).json({ error: 'Parâmetros inválidos.' });

  // Buscamos os telefones possíveis tanto de permissionário quanto de cliente de evento
  const sql = `
    SELECT
      d.id                  AS dar_id,
      d.pdf_url             AS pdf_url,
      p.telefone            AS tel_perm,
      p.telefone_cobranca   AS tel_cob,
      ce.telefone           AS tel_cli
    FROM dars d
    LEFT JOIN permissionarios p ON p.id = d.permissionario_id
    LEFT JOIN DARs_Eventos de   ON de.id_dar = d.id
    LEFT JOIN Eventos e         ON e.id = de.id_evento
    LEFT JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
   WHERE d.id = ?
   LIMIT 1
  `;

  db.get(sql, [darId], (err, row) => {
    if (err) {
      console.error('[BOT][PDF] ERRO SQL:', err.message);
      return res.status(500).json({ error: 'Erro interno.' });
    }
    if (!row) return res.status(404).json({ error: 'DAR não encontrada.' });

    const okPhone = phoneMatches(msisdn, [row.tel_perm, row.tel_cob, row.tel_cli]);
    if (!okPhone) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a acessar este DAR.' });
    }

    if (!row.pdf_url) {
      return res.status(404).json({ error: 'DAR ainda não possui PDF gerado.' });
    }

    // Link absoluto (S3/GCS) -> redirect
    if (/^https?:\/\//i.test(row.pdf_url)) {
      return res.redirect(row.pdf_url);
    }

    // Caminho relativo sob /public
    const abs = path.join(__dirname, '..', '..', 'public', row.pdf_url);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  });
});

/**
 * POST /api/bot/dars/:darId/emit
 * Body (opcional): { msisdn: "55..." }  -> valida a posse antes de emitir.
 * Dispara a emissão via SEFAZ e devolve os metadados da DAR recém emitida.
 */
router.post('/dars/:darId/emit', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);
  const msisdn = req.body?.msisdn ? digits(req.body.msisdn) : null;

  if (!darId) return res.status(400).json({ error: 'Parâmetro darId inválido.' });

  try {
    // Se informaram msisdn, valida a posse
    if (msisdn) {
      const checkSql = `
        SELECT
          p.telefone          AS tel_perm,
          p.telefone_cobranca AS tel_cob,
          ce.telefone         AS tel_cli
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

    // >>>>>>>>>>>>>> AQUI VOCÊ PLUGA SUA EMISSÃO REAL VIA SEFAZ <<<<<<<<<<<<<<
    const meta = await emitirDarViaSefaz(darId, contexto);
    // meta esperado: { numero_documento, linha_digitavel, pdf_url }

    return res.json({ ok: true, darId, ...meta });
  } catch (err) {
    console.error('[BOT][EMIT] erro ao emitir DAR:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao emitir a DAR.' });
  }
});

/**
 * Implementação de fachada que deve chamar sua rotina real de emissão.
 * Substitua este bloco para reutilizar seu serviço existente (o mesmo do admin).
 */
async function emitirDarViaSefaz(darId, contexto) {
  // TODO: troque isso pela sua função real, por exemplo:
  // const { emitirDarPermissionario, emitirDarEvento } = require('../services/sefazService');
  //
  // if (contexto.tipo === 'PERMISSIONARIO') {
  //   const out = await emitirDarPermissionario(darId);
  //   return { numero_documento: out.numero, linha_digitavel: out.linha, pdf_url: out.pdfUrl };
  // } else {
  //   const out = await emitirDarEvento(darId);
  //   return { numero_documento: out.numero, linha_digitavel: out.linha, pdf_url: out.pdfUrl };
  // }

  // Fallback de teste: marca um PDF “fake” local
  const fakePdf = `dars/${darId}.pdf`;
  try {
    const abs = path.join(__dirname, '..', '..', 'public', fakePdf);
    if (!fs.existsSync(path.dirname(abs))) fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, '%PDF-1.4\n% Fake PDF\n');

    await new Promise((resolve, reject) => {
      const sql = `UPDATE dars SET numero_documento = COALESCE(numero_documento, ?),
                                  linha_digitavel = COALESCE(linha_digitavel, ?),
                                  pdf_url = ?
                    WHERE id = ?`;
      const num = `DUMMY-${darId}`;
      const lin = `00000.00000 00000.000000 00000.000000 0 00000000000000`;
      db.run(sql, [num, lin, fakePdf, darId], function (e) {
        if (e) return reject(e);
        resolve();
      });
    });

    return {
      numero_documento: `DUMMY-${darId}`,
      linha_digitavel: `00000.00000 00000.000000 00000.000000 0 00000000000000`,
      pdf_url: fakePdf
    };
  } catch (e) {
    throw e;
  }
}

module.exports = router;
