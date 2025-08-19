// src/api/botRoutes.js
'use strict';
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const botAuthMiddleware = require('../middleware/botAuthMiddleware');

// === Integração SEFAZ (oficial do sistema) =========================
const {
  emitirGuiaSefaz,
  buildSefazPayloadPermissionario,
  buildSefazPayloadEvento,
} = require('../services/sefazService');

// === Reemissão (SELIC + 2%) ========================================
let calcularEncargosAtraso = null;
try {
  ({ calcularEncargosAtraso } = require('../services/cobrancaService'));
} catch (e) {
  console.warn('[BOT] cobrancaService não disponível — reemissão sem recalcular encargos.');
}

// === Token opcional no PDF (mesma lógica do sistema web) ===========
let gerarTokenDocumento = null, imprimirTokenEmPdf = null;
try {
  ({ gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token'));
} catch (e) {
  console.warn('[BOT] utils/token não disponível — PDF sem marcação de token.');
}

const router = express.Router();

// -------------------- DB --------------------
const defaultDbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(process.env.SQLITE_PATH || defaultDbPath);

try { db.configure && db.configure('busyTimeout', 5000); } catch {}

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
db.serialize(() => {
  ensureColumn('dars', 'status', 'TEXT');
  ensureColumn('dars', 'numero_documento', 'TEXT');
  ensureColumn('dars', 'linha_digitavel', 'TEXT');
  ensureColumn('dars', 'pdf_url', 'TEXT');
});

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
  const alt11 = ms.startsWith('55') ? ms.slice(2) : ms;

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
    ? `id, nome_empresa, cnpj, telefone, telefone_cobranca`
    : `id, nome_empresa, cnpj, telefone`;

  return new Promise((resolve, reject) => {
    db.all(`SELECT ${cols} FROM permissionarios`, [], (e, rows = []) => {
      if (e) return reject(e);
      for (const r of rows) {
        const cand = [r.telefone];
        if (hasCobr) cand.push(r.telefone_cobranca);
        if (phoneMatches(msisdn, cand)) {
          return resolve({ id: r.id, nome: r.nome_empresa, cnpj: r.cnpj, tipo: 'PERMISSIONARIO' });
        }
      }
      resolve(null);
    });
  });
}

// Busca um cliente de eventos por telefone
function findClienteEventoByMsisdn(msisdn) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT id, nome_razao_social, documento as cnpj, telefone FROM Clientes_Eventos`;
    db.all(sql, [], (e, rows = []) => {
      if (e) return reject(e);
      for (const r of rows) {
        if (phoneMatches(msisdn, [r.telefone])) {
          return resolve({ id: r.id, nome: r.nome_razao_social, cnpj: r.cnpj, tipo: 'CLIENTE_EVENTO' });
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
    SELECT d.id, d.valor, d.data_vencimento, d.status, d.numero_documento, d.linha_digitavel, d.pdf_url,
           d.mes_referencia, d.ano_referencia
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

// Decide se um DAR é de permissionário ou de evento + dados do contribuinte
async function obterContextoDar(darId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT
        d.*,
        p.id   AS perm_id, p.nome_empresa, p.cnpj AS perm_cnpj, p.telefone AS tel_perm, p.telefone_cobranca AS tel_cob,
        e.id   AS evento_id, ce.id AS cliente_id, ce.nome_razao_social, ce.documento AS cli_doc, ce.telefone AS tel_cli
      FROM dars d
      LEFT JOIN permissionarios p   ON p.id = d.permissionario_id
      LEFT JOIN DARs_Eventos de     ON de.id_dar = d.id
      LEFT JOIN Eventos e           ON e.id = de.id_evento
      LEFT JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
     WHERE d.id = ?
     LIMIT 1
    `;
    db.get(sql, [darId], (e, row) => {
      if (e) return reject(e);
      if (!row) return resolve(null);
      if (row.cliente_id) {
        return resolve({
          tipo: 'CLIENTE_EVENTO',
          dar: row,
          contribuinte: { id: row.cliente_id, nome: row.nome_razao_social, cnpj: row.cli_doc },
          tels: [row.tel_cli]
        });
      }
      if (row.perm_id) {
        const tels = [row.tel_perm];
        if (row.tel_cob) tels.push(row.tel_cob);
        return resolve({
          tipo: 'PERMISSIONARIO',
          dar: row,
          contribuinte: { id: row.perm_id, nome: row.nome_empresa, cnpj: row.perm_cnpj },
          tels
        });
      }
      resolve({ tipo: 'DESCONHECIDO', dar: row, contribuinte: null, tels: [] });
    });
  });
}

// -------------------- ROTAS --------------------

/**
 * GET /api/bot/dars?msisdn=55XXXXXXXXXXX
 * - Se 1 conta (permissionário), mantém resposta legada
 * - Se múltiplas, retorna { contas:[ ... ] }
 */
router.get('/dars', botAuthMiddleware, async (req, res) => {
  try {
    const msisdn = String(req.query.msisdn || '').trim();
    if (!msisdn) return res.status(400).json({ error: 'Parâmetro msisdn é obrigatório.' });

    const contas = [];

    const perm = await findPermissionarioByMsisdn(msisdn);
    if (perm) {
      const dars = await listarDarsPermissionario(perm.id);
      contas.push({ tipo: 'PERMISSIONARIO', id: perm.id, nome: perm.nome, dars });
    }

    const cli = await findClienteEventoByMsisdn(msisdn);
    if (cli) {
      const dars = await listarDarsClienteEvento(cli.id);
      contas.push({ tipo: 'CLIENTE_EVENTO', id: cli.id, nome: cli.nome, dars });
    }

    if (contas.length === 0) {
      return res.status(404).json({ error: 'Telefone não associado a nenhum permissionário/cliente.' });
    }

    if (contas.length === 1 && contas[0].tipo === 'PERMISSIONARIO') {
      const { id, nome, dars } = contas[0];
      return res.json({ ok: true, permissionario: { id, nome_empresa: nome }, dars });
    }

    return res.json({ ok: true, contas });
  } catch (err) {
    console.error('[BOT][dars] erro:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

/**
 * GET /api/bot/dars/:darId/pdf?msisdn=55XXXXXXXXXXX
 * Retorna o PDF gerado pela SEFAZ (base64) ou redireciona, validando posse por msisdn.
 */
router.get('/dars/:darId/pdf', botAuthMiddleware, async (req, res) => {
  try {
    const darId = Number(req.params.darId);
    const msisdn = String(req.query.msisdn || '').trim();
    if (!darId || !msisdn) return res.status(400).json({ error: 'Parâmetros inválidos.' });

    const ctx = await obterContextoDar(darId);
    if (!ctx || !ctx.dar) return res.status(404).json({ error: 'DAR não encontrada.' });
    if (!phoneMatches(msisdn, ctx.tels)) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a acessar este DAR.' });
    }

    const savedPdf = ctx.dar.pdf_url || '';
    if (!savedPdf || String(savedPdf).length < 20) {
      return res.status(404).json({ error: 'PDF indisponível para este DAR.' });
    }

    // base64 direto?
    const isBase64 = /^JVBER/i.test(savedPdf) || /^data:application\/pdf;base64,/i.test(savedPdf);
    if (isBase64) {
      const base64 = String(savedPdf).replace(/^data:application\/pdf;base64,/i, '');
      const buf = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="dar_${darId}.pdf"`);
      return res.send(buf);
    }

    // URL absoluta?
    if (/^https?:\/\//i.test(savedPdf)) {
      return res.redirect(302, savedPdf);
    }

    // Caminho relativo
    const rel = String(savedPdf).replace(/^\/+/, '');
    const upDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
    const pubDir = path.join(__dirname, '..', '..', 'public');
    const tryPaths = [path.join(upDir, rel), path.join(pubDir, rel)];
    const fsPath = tryPaths.find(p => fs.existsSync(p));
    if (!fsPath) {
      return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });
    }
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dar_${darId}.pdf"`);
    return fs.createReadStream(fsPath).pipe(res);
  } catch (err) {
    console.error('[BOT][PDF] erro:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

/**
 * POST /api/bot/dars/:darId/emit
 * Body opcional: { msisdn: "55..." } — valida posse.
 * Emite na SEFAZ usando o mesmo builder do sistema.
 */
router.post('/dars/:darId/emit', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);
  const msisdn = req.body?.msisdn ? digits(req.body.msisdn) : null;
  if (!darId) return res.status(400).json({ error: 'Parâmetro darId inválido.' });

  try {
    const ctx = await obterContextoDar(darId);
    if (!ctx || !ctx.dar) return res.status(404).json({ error: 'DAR não encontrada.' });

    if (msisdn && !phoneMatches(msisdn, ctx.tels)) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a emitir este DAR.' });
    }

    // Ajuste simples: se vencida, deixa a reemissão para a rota /reemit
    // Aqui emitimos como está — a SEFAZ clampa dataLimite >= hoje com nosso builder.

    let payload;
    if (ctx.tipo === 'PERMISSIONARIO') {
      payload = buildSefazPayloadPermissionario({
        perm: { cnpj: ctx.contribuinte.cnpj, nome_empresa: ctx.contribuinte.nome },
        darLike: {
          id: ctx.dar.id,
          valor: ctx.dar.valor,
          data_vencimento: ctx.dar.data_vencimento,
          mes_referencia: ctx.dar.mes_referencia,
          ano_referencia: ctx.dar.ano_referencia,
          numero_documento: ctx.dar.numero_documento
        }
      });
    } else if (ctx.tipo === 'CLIENTE_EVENTO') {
      payload = buildSefazPayloadEvento({
        cliente: { cnpj: ctx.contribuinte.cnpj, nome_razao_social: ctx.contribuinte.nome },
        parcela: {
          id: ctx.dar.id,
          valor: ctx.dar.valor,
          vencimento: ctx.dar.data_vencimento,
          competenciaMes: ctx.dar.mes_referencia,
          competenciaAno: ctx.dar.ano_referencia
        }
      });
    } else {
      return res.status(404).json({ error: 'DAR sem contexto de emissão.' });
    }

    const sefazResp = await emitirGuiaSefaz(payload);
    if (!sefazResp || !sefazResp.numeroGuia || !sefazResp.pdfBase64) {
      throw new Error('Retorno da SEFAZ incompleto (numeroGuia/pdfBase64).');
    }

    // Token opcional no PDF
    let pdfOut = sefazResp.pdfBase64;
    if (gerarTokenDocumento && imprimirTokenEmPdf) {
      try {
        const tokenDoc = await gerarTokenDocumento('DAR', ctx.contribuinte.id, db);
        pdfOut = await imprimirTokenEmPdf(pdfOut, tokenDoc);
      } catch (e) {
        console.warn('[BOT] Falha ao imprimir token no PDF (seguindo sem token):', e?.message || e);
      }
    }

    await new Promise((resolve, reject) => {
      const sql = `
        UPDATE dars
           SET numero_documento = ?,
               pdf_url = ?,
               linha_digitavel = COALESCE(?, linha_digitavel),
               status = 'Emitido'
         WHERE id = ?`;
      db.run(sql, [sefazResp.numeroGuia, pdfOut, sefazResp.linhaDigitavel || null, darId], function (e) {
        if (e) return reject(e);
        resolve();
      });
    });

    return res.json({
      ok: true,
      darId,
      numero_documento: sefazResp.numeroGuia,
      linha_digitavel: sefazResp.linhaDigitavel || null,
      pdf_url: pdfOut
    });
  } catch (err) {
    console.error('[BOT][EMIT] erro:', err);
    const isUnavailable =
      /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
        err.message || ''
      );
    return res.status(isUnavailable ? 503 : 500).json({ error: err.message || 'Falha ao emitir a DAR.' });
  }
});

/**
 * POST /api/bot/dars/:darId/reemit
 * Reemite DAR aplicando SELIC + 2% (via cobrancaService) e emitindo na SEFAZ.
 * Body obrigatório: { msisdn: "55..." }
 */
router.post('/dars/:darId/reemit', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);
  const msisdn = req.body?.msisdn ? digits(req.body.msisdn) : null;
  if (!darId || !msisdn) return res.status(400).json({ error: 'Parâmetros inválidos (darId/msisdn).' });

  try {
    const ctx = await obterContextoDar(darId);
    if (!ctx || !ctx.dar) return res.status(404).json({ error: 'DAR não encontrada.' });
    if (!phoneMatches(msisdn, ctx.tels)) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a reemitir este DAR.' });
    }

    // Recalcular encargos se serviço estiver disponível
    let valorParaEmitir = ctx.dar.valor;
    let novoVencimentoISO = ctx.dar.data_vencimento;

    if (calcularEncargosAtraso) {
      const calc = await calcularEncargosAtraso(ctx.dar);
      // Esperado do serviço: { valorAtualizado, novaDataVencimento?, atrasoDias, multa, juros }
      valorParaEmitir = calc?.valorAtualizado || ctx.dar.valor;
      novoVencimentoISO = calc?.novaDataVencimento || ctx.dar.data_vencimento;
    }

    let payload;
    if (ctx.tipo === 'PERMISSIONARIO') {
      payload = buildSefazPayloadPermissionario({
        perm: { cnpj: ctx.contribuinte.cnpj, nome_empresa: ctx.contribuinte.nome },
        darLike: {
          id: ctx.dar.id,
          valor: valorParaEmitir,
          data_vencimento: novoVencimentoISO,
          mes_referencia: ctx.dar.mes_referencia,
          ano_referencia: ctx.dar.ano_referencia,
          numero_documento: ctx.dar.numero_documento
        }
      });
    } else if (ctx.tipo === 'CLIENTE_EVENTO') {
      payload = buildSefazPayloadEvento({
        cliente: { cnpj: ctx.contribuinte.cnpj, nome_razao_social: ctx.contribuinte.nome },
        parcela: {
          id: ctx.dar.id,
          valor: valorParaEmitir,
          vencimento: novoVencimentoISO,
          competenciaMes: ctx.dar.mes_referencia,
          competenciaAno: ctx.dar.ano_referencia
        }
      });
    } else {
      return res.status(404).json({ error: 'DAR sem contexto de emissão.' });
    }

    const sefazResp = await emitirGuiaSefaz(payload);
    if (!sefazResp || !sefazResp.numeroGuia || !sefazResp.pdfBase64) {
      throw new Error('Retorno da SEFAZ incompleto (numeroGuia/pdfBase64).');
    }

    // Token opcional
    let pdfOut = sefazResp.pdfBase64;
    if (gerarTokenDocumento && imprimirTokenEmPdf) {
      try {
        const tokenDoc = await gerarTokenDocumento('DAR', ctx.contribuinte.id, db);
        pdfOut = await imprimirTokenEmPdf(pdfOut, tokenDoc);
      } catch {}
    }

    await new Promise((resolve, reject) => {
      const sql = `
        UPDATE dars
           SET numero_documento = ?,
               pdf_url = ?,
               linha_digitavel = COALESCE(?, linha_digitavel),
               status = 'Emitido'
         WHERE id = ?`;
      db.run(sql, [sefazResp.numeroGuia, pdfOut, sefazResp.linhaDigitavel || null, darId], function (e) {
        if (e) return reject(e);
        resolve();
      });
    });

    return res.json({
      ok: true,
      darId,
      numero_documento: sefazResp.numeroGuia,
      linha_digitavel: sefazResp.linhaDigitavel || null,
      pdf_url: pdfOut
    });
  } catch (err) {
    console.error('[BOT][REEMIT] erro:', err);
    const isUnavailable =
      /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
        err.message || ''
      );
    return res.status(isUnavailable ? 503 : 500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

module.exports = router;
