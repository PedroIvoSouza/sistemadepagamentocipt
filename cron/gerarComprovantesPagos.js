// cron/gerarComprovantesPagos.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { addDays, format, parseISO } = require('date-fns');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();

let gerarComprovante;
try {
  ({ gerarComprovante } = require('../src/services/comprovanteService'));
} catch (e) {
  // Serviço não disponível; o agendamento ainda ocorrerá mas acusará erro ao executar
}

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(__dirname, '..', process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function obterUltimoDiaProcessado() {
  await dbRun(
    `CREATE TABLE IF NOT EXISTS cron_runs (key TEXT PRIMARY KEY, last_run TEXT)`
  );
  const row = await dbGet(`SELECT last_run FROM cron_runs WHERE key = ?`, [
    'comprovantes_pagos',
  ]);
  if (row && row.last_run) {
    return parseISO(row.last_run);
  }
  const ontem = addDays(new Date(), -1);
  ontem.setHours(0, 0, 0, 0);
  return ontem;
}

async function registrarUltimoDiaProcessado(date) {
  const dia = format(date, 'yyyy-MM-dd');
  await dbRun(
    `INSERT INTO cron_runs (key, last_run) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET last_run = excluded.last_run`,
    ['comprovantes_pagos', dia]
  );
}

async function gerarComprovantesPagos(diaIso) {
  if (typeof gerarComprovante !== 'function') {
    console.error('[CRON][COMPROVANTES] Serviço gerarComprovante indisponível.');
    return;
  }

  let dars = [];
  try {
    dars = await dbAll(
      `SELECT id FROM dars WHERE status = 'Pago'
       AND date(data_pagamento) = ?
       AND (comprovante_token IS NULL OR comprovante_token = '')`,
      [diaIso]
    );
  } catch (e) {
    console.error('[CRON][COMPROVANTES] Falha ao consultar DARs:', e.message || e);
    return;
  }

  for (const dar of dars) {
    try {
      const token = await gerarComprovante(dar.id);
      console.log(
        `[CRON][COMPROVANTES] Comprovante gerado para DAR #${dar.id} (token: ${token}).`
      );
    } catch (e) {
      console.error(
        `[CRON][COMPROVANTES] Erro ao gerar comprovante da DAR #${dar.id}:`,
        e.message || e
      );
    }
  }
}

async function processarDiasPendentes() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  let ultimo = await obterUltimoDiaProcessado();
  ultimo.setHours(0, 0, 0, 0);

  for (let dia = addDays(ultimo, 1); dia <= hoje; dia = addDays(dia, 1)) {
    const iso = format(dia, 'yyyy-MM-dd');
    console.log(`[CRON][COMPROVANTES] Processando dia ${iso}...`);
    await gerarComprovantesPagos(iso);
    await registrarUltimoDiaProcessado(dia);
  }
}

processarDiasPendentes();
cron.schedule('0 6 * * *', processarDiasPendentes, {
  timezone: 'America/Sao_Paulo',
});
