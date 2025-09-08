// cron/gerarComprovantesPagos.js
// Execução imediata (backfill) + agendamento diário às 06:30 (America/Maceio).
// Gera/garante comprovantes para DARs com status "Pago" (ou variações).
//
// Como rodar agora (uma vez em foreground):
//   node cron/gerarComprovantesPagos.js
//
// Em background (nohup):
//   nohup node cron/gerarComprovantesPagos.js >> logs/cron-gerarComprovantes.master.log 2>&1 &
//
// Com PM2 (recomendado):
//   pm2 start cron/gerarComprovantesPagos.js --name cron-gerar-comprovantes --time
//   pm2 save
//
// Flags úteis:
//   --once               Roda o backfill imediato e encerra (não agenda)
//   --limit=5            Limite de concorrência (padrão: 3)
//   --days=3             Janela (em dias) usada no agendamento diário para buscar recém-pagos (padrão: 2)
//   --dry                Não chama gerarComprovante; apenas lista o que faria

require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

// ==== Configs básicas ====
const TZ = 'America/Maceio';
const CRON_EXPR = '30 6 * * *'; // 06:30 todos os dias
const CONCURRENCY = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || process.env.COMP_CONCURRENCY || 3);
const DAILY_DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1] || process.env.COMP_DAILY_DAYS || 2);
const DRY_RUN = process.argv.includes('--dry');
const RUN_ONCE = process.argv.includes('--once');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const ts = () => new Date().toISOString();

function log(...args) { console.log(`[CRON][COMPROVANTES]`, ...args); }
function err(...args) { console.error(`[CRON][COMPROVANTES][ERRO]`, ...args); }

// ==== DB & Service ====
const db = new sqlite3.Database(DB_PATH, (e) => {
  if (e) err('Abrindo DB:', e.message);
  else log('DB aberto em', DB_PATH);
});

// Importa do arquivo correto (conforme seu código)
const { gerarComprovante } = require('../src/services/darComprovanteService');

// ==== Helpers genéricos ====
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (e, row) => e ? reject(e) : resolve(row));
  });
}

async function tableHasColumn(table, column) {
  try {
    const cols = await all(db, `PRAGMA table_info(${table})`);
    return cols.some(c => c.name === column);
  } catch {
    return false;
  }
}

async function firstQueryThatWorks(queries) {
  for (const q of queries) {
    try {
      const rows = await all(db, q.sql, q.params || []);
      if (rows && rows.length >= 0) return { ok: true, rows, used: q };
    } catch (e) {
      // tenta próxima
    }
  }
  return { ok: false, rows: [], used: null };
}

async function mapWithConcurrency(items, limit, worker) {
  const ret = [];
  let i = 0, active = 0, rejectFn;
  return await new Promise((resolve, reject) => {
    rejectFn = reject;
    const next = () => {
      if (i >= items.length && active === 0) return resolve(ret);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then(r => ret[idx] = r)
          .catch(e => { err('Worker falhou:', e.message); ret[idx] = { error: e }; })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

async function callWithRetry(label, fn, tries = 5) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const back = Math.min(15000, 1000 * 2 ** i);
      err(`${label}: tentativa ${i}/${tries} falhou: ${e.message}; retry em ${back}ms`);
      await new Promise(r => setTimeout(r, back));
    }
  }
  throw last;
}

// ==== Seleção de DARs pagas ====
// 1) Backfill: pega TODAS as DARs pagas.
// 2) Execução diária: pega pagas em uma janela (N dias) — mas mesmo que já tenham token, o service deve reusar (reuseExisting: true).

async function listarDARsPagas({ fromISO = null, toISO = null } = {}) {
  // Detecta colunas disponíveis para tentar filtrar por data
  const hasDataPag = await tableHasColumn('dars', 'data_pagamento');
  const hasPagoAt   = await tableHasColumn('dars', 'pago_em');
  const hasAtual    = await tableHasColumn('dars', 'updated_at');

  // Monta filtros de status "pago"
  const statusFilter = `LOWER(status) LIKE 'pago%' OR LOWER(status)='paid'`;

  // Filtros de data (tentativa progressiva)
  let dateClause = '';
  let params = [];

  if (fromISO && toISO) {
    if (hasDataPag) {
      dateClause = `AND date(data_pagamento) BETWEEN date(?) AND date(?)`;
      params = [fromISO, toISO];
    } else if (hasPagoAt) {
      dateClause = `AND date(pago_em) BETWEEN date(?) AND date(?)`;
      params = [fromISO, toISO];
    } else if (hasAtual) {
      dateClause = `AND date(updated_at) BETWEEN date(?) AND date(?)`;
      params = [fromISO, toISO];
    }
  }

  // Consultas candidatas
  const queries = [
    { sql: `SELECT id FROM dars WHERE (${statusFilter}) ${dateClause} ORDER BY id ASC`, params },
    // Alguns ambientes usam outra tabela:
    { sql: `SELECT id FROM DARs_Eventos WHERE (${statusFilter}) ${dateClause} ORDER BY id ASC`, params },
    // Fallback: sem filtro de data
    { sql: `SELECT id FROM dars WHERE (${statusFilter}) ORDER BY id ASC`, params: [] },
    { sql: `SELECT id FROM DARs_Eventos WHERE (${statusFilter}) ORDER BY id ASC`, params: [] },
  ];

  const { ok, rows, used } = await firstQueryThatWorks(queries);
  if (!ok) {
    throw new Error('Nenhuma consulta de DARs pagas funcionou (tabelas/colunas não encontradas).');
  }
  log(`Consulta utilizada:`, used.sql.replace(/\s+/g, ' ').trim());
  return rows.map(r => r.id);
}

// ==== Execução por lote ====
async function gerarParaLista(ids, { label = 'lote', reuseExisting = true } = {}) {
  if (!ids || !ids.length) {
    log(`[${label}] Nenhuma DAR para processar.`);
    return { ok: 0, fail: 0 };
  }
  log(`[${label}] Processando ${ids.length} DAR(s) com concorrência=${CONCURRENCY}${DRY_RUN ? ' [DRY RUN]' : ''}…`);

  let ok = 0, fail = 0;
  await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
    try {
      if (DRY_RUN) { log(`[${label}] (dry) dar=${id}`); ok++; return; }
      const res = await callWithRetry(`gerarComprovante(dar=${id})`, () =>
        gerarComprovante(id, db, { reuseExisting })
      );
      const tk = res?.token ? ` token=${res.token}` : '';
      log(`[${label}] OK dar=${id}${tk}`);
      ok++;
    } catch (e) {
      err(`[${label}] dar=${id}:`, e.message);
      fail++;
    }
  });

  log(`[${label}] Concluído: OK=${ok} ERRO=${fail}`);
  return { ok, fail };
}

// ==== Janela diária (America/Maceio) ====
function getLocalISODate(d) {
  // Retorna YYYY-MM-DD em America/Maceio sem libs externas
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayLocal() {
  // Converte "agora" para horário local do Brasil (Maceió)
  const now = new Date();
  // Hack sem libs: cria uma data com o offset local do servidor, mas usamos apenas a data
  return getLocalISODate(now);
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return getLocalISODate(dt);
}

// ==== Fluxos ====
async function backfillCompleto() {
  log(`Início do BACKFILL @ ${ts()} — buscando TODAS as DARs pagas…`);
  const ids = await listarDARsPagas(); // sem janela -> todas as pagas
  return await gerarParaLista(ids, { label: 'BACKFILL', reuseExisting: true });
}

async function execucaoDiaria() {
  // janela padrão: últimos N dias para capturar pagamentos que “caíram” tarde
  const hoje = todayLocal();
  const from = addDays(hoje, -DAILY_DAYS);
  const to = hoje;
  log(`Execução DIÁRIA @ ${ts()} — janela ${from} .. ${to}`);
  const ids = await listarDARsPagas({ fromISO: from, toISO: to });
  return await gerarParaLista(ids, { label: `DIARIO_${from}_a_${to}`, reuseExisting: true });
}

// ==== Bootstrap & Agendamento ====
async function main() {
  try {
    // 1) Backfill imediato (busca tudo) — uma vez no start
    await backfillCompleto();

    if (RUN_ONCE) {
      log('Flag --once detectada: finalizando após o backfill.');
      process.exit(0);
      return;
    }

    // 2) Agenda execução diária 06:30 (America/Maceio)
    log(`Agendando execução diária para '${CRON_EXPR}' em ${TZ}`);
    cron.schedule(CRON_EXPR, async () => {
      try {
        await execucaoDiaria();
      } catch (e) {
        err('Falha na execução diária:', e.message);
      }
    }, { timezone: TZ });

    log('Agendamento ativo. Aguardando próximos disparos…');
  } catch (e) {
    err('Falha no bootstrap:', e.message);
    process.exitCode = 1;
  }
}

// ==== Sinais & finalização ====
process.on('SIGINT', () => { log('SIGINT recebido. Encerrando…'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM recebido. Encerrando…'); process.exit(0); });
process.on('exit', () => {
  try { db.close(); log('DB fechado.'); } catch {}
  log(`EXIT @ ${ts()}`);
});

main();
