// scripts/precachePagamentos.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const {
  listarPagamentosPorDataArrecadacao,
} = require('../src/services/sefazService');
const { toISO } = require('../src/utils/sefazPayload');

const DB_PATH = process.env.SQLITE_STORAGE || './sistemacipt.db';
const db = new sqlite3.Database(DB_PATH);

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

async function precacheDar(darId, diasAntes = 30, diasDepois = 10) {
  const dar = await dbGet(
    `SELECT id, numero_documento, linha_digitavel, codigo_barras, data_vencimento
       FROM dars WHERE id = ?`,
    [darId]
  );
  if (!dar) throw new Error('DAR não encontrada');

  const inicio = new Date(dar.data_vencimento);
  const cache = [];

  for (
    let delta = -diasAntes;
    delta <= diasDepois;
    delta += 1
  ) {
    const dia = new Date(inicio);
    dia.setDate(inicio.getDate() + delta);
    const diaISO = toISO(dia);
    try {
      const itens = await listarPagamentosPorDataArrecadacao(diaISO, diaISO);
      const match = itens.find(
        (p) =>
          p.numeroGuia === dar.numero_documento ||
          p.codigoBarras === dar.codigo_barras ||
          p.linhaDigitavel === dar.linha_digitavel
      );
      if (match) cache.push(match);
    } catch (e) {
      console.warn(`Falha ao consultar ${diaISO}:`, e.message);
    }
  }

  const outDir = path.resolve(__dirname, '../cache');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `dar-${darId}-pagamentos.json`);
  fs.writeFileSync(outFile, JSON.stringify(cache, null, 2));
  console.log(`Cache salvo em ${outFile}`);
}

if (require.main === module) {
  const darId = Number(process.argv[2]);
  if (!darId) {
    console.error('Uso: node scripts/precachePagamentos.js <DAR_ID>');
    process.exit(1);
  }
  precacheDar(darId)
    .catch((e) => console.error('Erro:', e.message || e))
    .finally(() => db.close());
}
