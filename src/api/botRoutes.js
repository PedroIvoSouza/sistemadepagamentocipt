// src/api/botRoutes.js
'use strict';
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const botAuthMiddleware = require('../middleware/botAuthMiddleware');
const { codigoBarrasParaLinhaDigitavel } = require('../utils/boleto');

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

// util promessas
const qAll = (sql, params=[]) => new Promise((resolve,reject)=>db.all(sql, params, (e,rows)=>e?reject(e):resolve(rows||[])));
const qGet = (sql, params=[]) => new Promise((resolve,reject)=>db.get(sql, params, (e,row)=>e?reject(e):resolve(row||null)));
const qRun = (sql, params=[]) => new Promise((resolve,reject)=>db.run(sql, params, function(e){ e?reject(e):resolve(this); }));

// Garante colunas básicas em dars (idempotente)
async function ensureColumn(table, column, type) {
  try {
    const rows = await qAll(`PRAGMA table_info(${table})`);
    if (!rows.some(r => r.name === column)) {
      await qRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`[DB] ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch (e) {
    // ignora se a tabela não existir aqui — o app já usa dars.
    // mas loga
    console.warn(`[DB] ensureColumn falhou ${table}.${column}:`, e.message || e);
  }
}

(async () => {
  await ensureColumn('dars', 'status', 'TEXT');
  await ensureColumn('dars', 'codigo_barras', 'TEXT');
  await ensureColumn('dars', 'numero_documento', 'TEXT');
  await ensureColumn('dars', 'linha_digitavel', 'TEXT');
  await ensureColumn('dars', 'pdf_url', 'TEXT');
  await ensureColumn('permissionarios', 'telefone_cobranca', 'TEXT');
})().catch(()=>{});

// -------------------- helpers --------------------
const digits = (s = '') => String(s).replace(/\D/g, '');
const last11 = (s = '') => {
  const d = digits(s);
  return d.length > 11 ? d.slice(-11) : d;
};

// Tenta casar msisdn contra uma lista de telefones em vários formatos
function phoneMatches(msisdn, phoneList = []) {
  const ms = digits(msisdn);
  if (!ms) return false;
  const ms11 = last11(ms);
  const alt11 = ms.startsWith('55') ? ms.slice(2) : ms;

  for (const raw of phoneList) {
    if (!raw) continue;
    const p = digits(raw);
    if (!p) continue;
    if (p === ms || p === alt11 || last11(p) === ms11 || last11(ms) === last11(p)) return true;
  }
  return false;
}

// -------------------- DETECÇÃO DE ESQUEMA (tabelas/colunas) --------------------
let schemaCache = null;

async function refreshSchema() {
  const tables = await qAll(`SELECT name FROM sqlite_master WHERE type='table'`);
  const tnames = new Set(tables.map(t => (t.name || '').toLowerCase()));

  // permissionarios.telefone_cobranca?
  let hasTelCobranca = false;
  try {
    const cols = await qAll(`PRAGMA table_info(permissionarios)`);
    hasTelCobranca = cols.some(c => (c.name||'').toLowerCase() === 'telefone_cobranca');
  } catch {}

  // candidatos para tabelas de eventos
  const resolveTable = (cands) => {
    for (const c of cands) {
      if (tnames.has(c.toLowerCase())) return c;
    }
    return null;
  };

  const tEventos       = resolveTable(['Eventos','eventos']);
  const tDarsEventos   = resolveTable(['DARs_Eventos','dars_eventos','darsEventos','Dars_Eventos']);
  const tClientes      = resolveTable(['Clientes_Eventos','clientes_evento','clientes_eventos','Clientes_Evento']);

  // extrai colunas com heurística
  const tableInfo = async (t) => t ? await qAll(`PRAGMA table_info(${t})`).catch(()=>[]) : [];

  const colsEventos     = await tableInfo(tEventos);
  const colsDarsEventos = await tableInfo(tDarsEventos);
  const colsClientes    = await tableInfo(tClientes);

  const colBy = (cols, candidates) => {
    const names = cols.map(c => (c.name||'').toLowerCase());
    for (const c of candidates) {
      const i = names.indexOf(c.toLowerCase());
      if (i >= 0) return cols[i].name; // devolve com o case real
    }
    return null;
  };

  // Eventos: id, (id_cliente|cliente_id)
  const ev_id         = colBy(colsEventos, ['id']) || 'id';
  const ev_cliente_id = colBy(colsEventos, ['id_cliente','cliente_id']);

  // DARs_Eventos: (id_dar|dar_id), (id_evento|evento_id)
  const de_dar_id     = colBy(colsDarsEventos, ['id_dar','dar_id']);
  const de_evento_id  = colBy(colsDarsEventos, ['id_evento','evento_id']);

  // Clientes_Eventos: id, nome, documento, telefone (com heurística ampla)
  const cli_id        = colBy(colsClientes, ['id']) || 'id';
  const cli_nome      = colBy(colsClientes, ['nome_razao_social','nome','razao_social','nome_fantasia']);
  const cli_doc       = colBy(colsClientes, ['documento','cnpj','cpf']);
  // qualquer coluna com tel/cel
  const cli_tel       = (() => {
    const telCols = colsClientes
      .map(c => c.name)
      .filter(n => /tel|cel/i.test(n || ''));
    return telCols[0] || null;
  })();

  const hasEventos = !!(tEventos && tDarsEventos && tClientes && ev_cliente_id && de_dar_id && de_evento_id && cli_nome && cli_doc && cli_tel);

  schemaCache = {
    hasTelCobranca,
    hasEventos,
    tEventos, tDarsEventos, tClientes,
    ev_id, ev_cliente_id,
    de_dar_id, de_evento_id,
    cli_id, cli_nome, cli_doc, cli_tel
  };

  if (!hasEventos) {
    console.warn('[BOT] Tabelas de eventos ausentes/incompletas — buscas por cliente de evento serão ignoradas.');
  }
  if (!hasTelCobranca) {
    console.warn('[BOT] Coluna permissionarios.telefone_cobranca ausente — só telefone principal será considerado.');
  }
  return schemaCache;
}

async function getSchema() {
  if (schemaCache) return schemaCache;
  return refreshSchema();
}

// -------------------- LOOKUPS --------------------

// Busca um permissionário pelo msisdn (telefone principal e, se existir, cobrança)
async function findPermissionarioByMsisdn(msisdn) {
  const schema = await getSchema();
  const cols = ['id','nome_empresa','cnpj','telefone'];
  if (schema.hasTelCobranca) cols.push('telefone_cobranca');

  const rows = await qAll(`SELECT ${cols.join(', ')} FROM permissionarios`);
  for (const r of rows) {
    const cand = [r.telefone];
    if (schema.hasTelCobranca) cand.push(r.telefone_cobranca);
    if (phoneMatches(msisdn, cand)) {
      return { id: r.id, nome: r.nome_empresa, cnpj: r.cnpj, tipo: 'PERMISSIONARIO' };
    }
  }
  return null;
}

// Busca cliente de evento por msisdn (se esquema existir)
async function findClienteEventoByMsisdn(msisdn) {
  const s = await getSchema();
  if (!s.hasEventos) return null;
  try {
    const sql = `SELECT ${s.cli_id} as id, ${s.cli_nome} as nome, ${s.cli_doc} as doc, ${s.cli_tel} as telefone FROM ${s.tClientes}`;
    const rows = await qAll(sql);
    for (const r of rows) {
      if (phoneMatches(msisdn, [r.telefone])) {
        return { id: r.id, nome: r.nome, cnpj: r.doc, tipo: 'CLIENTE_EVENTO' };
      }
    }
  } catch (e) {
    // se der "no such table/column", ignora e segue
    if (!/no such/i.test(e.message||'')) throw e;
  }
  return null;
}

// Lista DARs pendentes (permissionário)
function listarDarsPermissionario(permissionarioId) {
  const sqlVencidas = `
    SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url, mes_referencia, ano_referencia
      FROM dars
      WHERE permissionario_id = ?
        AND (status IS NULL OR status <> 'Pago')
        AND DATE(data_vencimento) < DATE('now')
      ORDER BY DATE(data_vencimento) ASC, id ASC;
  `;
  const sqlVigente = `
    SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url, mes_referencia, ano_referencia
      FROM dars
      WHERE permissionario_id = ?
        AND (status IS NULL OR status <> 'Pago')
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

// Lista DARs pendentes (cliente evento), se esquema existir
async function listarDarsClienteEvento(clienteId) {
  const s = await getSchema();
  if (!s.hasEventos) return { vigente: null, vencidas: [] };

  const base = `
    SELECT d.id, d.valor, d.data_vencimento, d.status, d.numero_documento, d.linha_digitavel, d.pdf_url,
           d.mes_referencia, d.ano_referencia
      FROM dars d
      JOIN ${s.tDarsEventos} de ON de.${s.de_dar_id} = d.id
      JOIN ${s.tEventos} e ON e.${s.ev_id} = de.${s.de_evento_id}
     WHERE e.${s.ev_cliente_id} = ?
       AND (d.status IS NULL OR d.status <> 'Pago')
  `;
  const sqlVencidas = `${base} AND DATE(d.data_vencimento) < DATE('now')
                       ORDER BY DATE(d.data_vencimento) ASC, d.id ASC`;
  const sqlVigente = `${base} AND DATE(d.data_vencimento) >= DATE('now')
                      ORDER BY DATE(d.data_vencimento) ASC, d.id ASC
                      LIMIT 1`;
  const vencidas = await qAll(sqlVencidas, [clienteId]).catch(e=>{
    if (/no such/i.test(e.message||'')) return [];
    throw e;
  });
  const vigenteRow = await qGet(sqlVigente, [clienteId]).catch(e=>{
    if (/no such/i.test(e.message||'')) return null;
    throw e;
  });
  return { vigente: vigenteRow || null, vencidas };
}

// Decide se um DAR é de permissionário ou de evento + dados do contribuinte
async function obterContextoDar(darId) {
  const s = await getSchema();

  // monta SELECT dinâmico
  const permCols = ['p.id AS perm_id', 'p.nome_empresa', 'p.cnpj AS perm_cnpj', 'p.telefone AS tel_perm'];
  if (s.hasTelCobranca) permCols.push('p.telefone_cobranca AS tel_cob');

  let sql = `
    SELECT
      d.*,
      ${permCols.join(', ')}
  `;

  if (s.hasEventos) {
    sql += `,
      e.${s.ev_id}  AS evento_id,
      ce.${s.cli_id} AS cliente_id,
      ce.${s.cli_nome} AS nome_razao_social,
      ce.${s.cli_doc}  AS cli_doc,
      ce.${s.cli_tel}  AS tel_cli
    `;
  }

  sql += `
    FROM dars d
    LEFT JOIN permissionarios p ON p.id = d.permissionario_id
  `;

  if (s.hasEventos) {
    sql += `
      LEFT JOIN ${s.tDarsEventos} de ON de.${s.de_dar_id} = d.id
      LEFT JOIN ${s.tEventos} e     ON e.${s.ev_id}       = de.${s.de_evento_id}
      LEFT JOIN ${s.tClientes} ce   ON ce.${s.cli_id}     = e.${s.ev_cliente_id}
    `;
  }

  sql += ` WHERE d.id = ? LIMIT 1`;

  // executa
  let row;
  try {
    row = await qGet(sql, [darId]);
  } catch (e) {
    // se falhar por esquema de eventos, tenta apenas perm
    if (/no such/i.test(e.message||'')) {
      const sqlPerm = `
        SELECT d.*, p.id AS perm_id, p.nome_empresa, p.cnpj AS perm_cnpj, p.telefone AS tel_perm
        FROM dars d
        LEFT JOIN permissionarios p ON p.id = d.permissionario_id
        WHERE d.id = ? LIMIT 1
      `;
      row = await qGet(sqlPerm, [darId]);
    } else {
      throw e;
    }
  }

  if (!row) return null;

  // cliente de evento tem prioridade se presente
  if (row.cliente_id) {
    return {
      tipo: 'CLIENTE_EVENTO',
      dar: row,
      contribuinte: { id: row.cliente_id, nome: row.nome_razao_social, cnpj: row.cli_doc },
      tels: [row.tel_cli].filter(Boolean)
    };
  }

  if (row.perm_id) {
    const tels = [row.tel_perm];
    if (row.tel_cob) tels.push(row.tel_cob);
    return {
      tipo: 'PERMISSIONARIO',
      dar: row,
      contribuinte: { id: row.perm_id, nome: row.nome_empresa, cnpj: row.perm_cnpj },
      tels: tels.filter(Boolean)
    };
  }

  return { tipo: 'DESCONHECIDO', dar: row, contribuinte: null, tels: [] };
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

    // garante schema cache
    await getSchema();

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
    console.error('[BOT][dars] erro:', err, err?.detail);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

/**
 * GET /api/bot/dars/:darId?msisdn=55XXXXXXXXXXX
 * Retorna informações básicas do DAR, validando a posse via msisdn.
 */
router.get('/dars/:darId', botAuthMiddleware, async (req, res) => {
  try {
    const darId = Number(req.params.darId);
    const msisdn = String(req.query.msisdn || '').trim();
    if (!darId || !msisdn) {
      return res.status(400).json({ error: 'Parâmetros inválidos.' });
    }

    const ctx = await obterContextoDar(darId);
    if (!ctx || !ctx.dar) {
      return res.status(404).json({ error: 'DAR não encontrada.' });
    }
    if (!phoneMatches(msisdn, ctx.tels)) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a acessar este DAR.' });
    }

    const {
  linha_digitavel,
  valor,
  data_vencimento,
  mes_referencia,
  ano_referencia,
  codigo_barras,          // <— garanta que está sendo selecionado no SELECT
  numero_documento        // (não use isso para converter!)
} = ctx.dar;

let ld = (linha_digitavel || '').replace(/\D/g, '');
if (!ld) {
  const cb = (codigo_barras || '').replace(/\D/g, '');
  if (cb) {
    ld = codigoBarrasParaLinhaDigitavel(cb) || '';
    if (ld) {
      try {
        await qRun('UPDATE dars SET linha_digitavel = ? WHERE id = ?', [ld, ctx.dar.id]);
      } catch {}
    }
  }
}

const competencia = `${String(mes_referencia).padStart(2, '0')}/${ano_referencia}`;

return res.json({
  ok: true,
  dar: {
    id: ctx.dar.id,
    linha_digitavel: ld || null,
    competencia,
    vencimento: data_vencimento,
    valor
  }
});
  } catch (err) {
    console.error('[BOT][DAR] erro:', err, err?.detail);
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
    console.error('[BOT][PDF] erro:', err, err?.detail);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

/**
 * POST /api/bot/dars/:darId/emit
 * Body opcional: { msisdn: "55..." } — valida posse.
 * Emite na SEFAZ usando o mesmo builder do sistema.
 * Retorna 409 se o DAR já estiver "Emitido" ou "Reemitido".
 */
router.post('/dars/:darId/emit', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);
  // msisdn agora vem preferencialmente no corpo, mas aceitamos query como fallback
  const msisdn = req.body?.msisdn
    ? digits(req.body.msisdn)
    : (req.query?.msisdn ? digits(req.query.msisdn) : null);
  if (!darId) return res.status(400).json({ error: 'Parâmetro darId inválido.' });

  try {
    const ctx = await obterContextoDar(darId);
    if (!ctx || !ctx.dar) return res.status(404).json({ error: 'DAR não encontrada.' });

    if (msisdn && !phoneMatches(msisdn, ctx.tels)) {
      return res.status(403).json({ error: 'Este telefone não está autorizado a emitir este DAR.' });
    }

    if (['Emitido', 'Reemitido'].includes(ctx.dar.status)) {
      return res.status(409).json({
        error: `DAR já ${ctx.dar.status.toLowerCase()}.`,
        status: ctx.dar.status,
        hint: 'Se precisar gerar novamente, utilize /api/bot/dars/:darId/reemit.'
      });
    }

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

    const codigoBarras = sefazResp.codigoBarras || null;
    const linhaDigitavel =
      (sefazResp.linhaDigitavel && sefazResp.linhaDigitavel.trim()) ||
      (codigoBarras ? codigoBarrasParaLinhaDigitavel(codigoBarras) : null);

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

    await qRun(
      `UPDATE dars
         SET numero_documento = ?,
             pdf_url = ?,
             codigo_barras = COALESCE(?, codigo_barras),
             linha_digitavel = COALESCE(?, linha_digitavel),
             status = 'Emitido'
       WHERE id = ?`,
      [sefazResp.numeroGuia, pdfOut, codigoBarras, linhaDigitavel, darId]
    );

    return res.json({
      ok: true,
      darId,
      numero_documento: sefazResp.numeroGuia,
      linha_digitavel: linhaDigitavel,
      codigo_barras: codigoBarras,
      pdf_url: pdfOut
    });
  } catch (err) {
    console.error('[BOT][EMIT] erro:', err, err?.detail);
    const isUnavailable =
      /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
        err.message || ''
      );
    const status = err.status || (isUnavailable ? 503 : 500);
    const body = { error: err.message || 'Falha ao emitir a DAR.' };
    if (err.detail) body.detail = err.detail;
    return res.status(status).json(body);
  }
});

/**
 * POST /api/bot/dars/:darId/reemit
 * Reemite DAR aplicando SELIC + 2% (via cobrancaService) e emitindo na SEFAZ.
 * Body obrigatório: { msisdn: "55..." }
 */
router.post('/dars/:darId/reemit', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);
  // Preferimos msisdn no corpo, mas aceitamos query como compatibilidade
  const msisdn = req.body?.msisdn
    ? digits(req.body.msisdn)
    : (req.query?.msisdn ? digits(req.query.msisdn) : null);
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
      // Esperado: { valorAtualizado, novaDataVencimento?, atrasoDias, multa, juros }
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

    const codigoBarras = sefazResp.codigoBarras || null;
    const linhaDigitavel =
      (sefazResp.linhaDigitavel && sefazResp.linhaDigitavel.trim()) ||
      (codigoBarras ? codigoBarrasParaLinhaDigitavel(codigoBarras) : null);

    // Token opcional
    let pdfOut = sefazResp.pdfBase64;
    if (gerarTokenDocumento && imprimirTokenEmPdf) {
      try {
        const tokenDoc = await gerarTokenDocumento('DAR', ctx.contribuinte.id, db);
        pdfOut = await imprimirTokenEmPdf(pdfOut, tokenDoc);
      } catch {}
    }

    await qRun(
      `UPDATE dars
         SET numero_documento = ?,
             pdf_url = ?,
             codigo_barras = COALESCE(?, codigo_barras),
             linha_digitavel = COALESCE(?, linha_digitavel),
             status = 'Reemitido'
       WHERE id = ?`,
      [sefazResp.numeroGuia, pdfOut, codigoBarras, linhaDigitavel, darId]
    );

    return res.json({
      ok: true,
      darId,
      numero_documento: sefazResp.numeroGuia,
      linha_digitavel: linhaDigitavel,
      codigo_barras: codigoBarras,
      pdf_url: pdfOut
    });
  } catch (err) {
    console.error('[BOT][REEMIT] erro:', err, err?.detail);
    const isUnavailable =
      /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
        err.message || ''
      );
    const status = err.status || (isUnavailable ? 503 : 500);
    const body = { error: err.message || 'Falha ao reemitir a DAR.' };
    if (err.detail) body.detail = err.detail;
    return res.status(status).json(body);
  }
});

module.exports = router;
