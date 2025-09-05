// cron/gerarComprovantesPagos.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

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

async function gerarComprovantesPagos() {
  if (typeof gerarComprovante !== 'function') {
    console.error('[CRON][COMPROVANTES] Serviço gerarComprovante indisponível.');
    return;
  }

  let dars = [];
  try {
    dars = await dbAll(
      `SELECT id FROM dars WHERE status = 'Pago' AND (comprovante_token IS NULL OR comprovante_token = '')`
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

// Agenda execução a cada 15 minutos
cron.schedule('*/15 * * * *', gerarComprovantesPagos);
