// scripts/atualizar_db_v9.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: path.resolve('.env') });

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve('./sistemacipt.db');

console.log('=== Atualização do banco (v9): colunas novas e migração de dados ===');
console.log('Usando DB:', DB_PATH);
const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function ensureColumn(table, column, type) {
  const row = await get(`PRAGMA table_info(${table})`);
  // não dá pra filtrar por nome direto, então vamos pegar todos e checar depois
  const cols = await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => (err ? reject(err) : resolve(rows)));
  });
  const exists = cols.some(c => c.name === column);
  if (exists) {
    console.log(`ℹ️ ${table}.${column} já existe.`);
    return;
  }
  try {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`✅ ${table}.${column} criado (${type}).`);
  } catch (e) {
    if (e.message.includes('duplicate column name')) {
      console.log(`ℹ️ ${table}.${column} já existe (race condition).`);
    } else {
      throw e;
    }
  }
}

(async () => {
  try {
    // 1) Garantir as colunas novas
    await ensureColumn('dars', 'numero_documento', 'TEXT');
    await ensureColumn('dars', 'pdf_url', 'TEXT');
    await ensureColumn('permissionarios', 'numero_documento', 'TEXT');

    // 2) Migrar dados antigos (se existirem)
    // dars.codigo_barras -> dars.numero_documento
    try {
      await run(`
        UPDATE dars
           SET numero_documento = codigo_barras
         WHERE (numero_documento IS NULL OR numero_documento = '')
           AND codigo_barras IS NOT NULL
           AND TRIM(codigo_barras) <> ''
      `);
      console.log('✅ Migração dars.codigo_barras -> dars.numero_documento concluída.');
    } catch (e) {
      console.log('ℹ️ Ignorando migração de codigo_barras (talvez a coluna não exista):', e.message);
    }

    // dars.link_pdf -> dars.pdf_url
    try {
      await run(`
        UPDATE dars
           SET pdf_url = link_pdf
         WHERE (pdf_url IS NULL OR pdf_url = '')
           AND link_pdf IS NOT NULL
           AND TRIM(link_pdf) <> ''
      `);
      console.log('✅ Migração dars.link_pdf -> dars.pdf_url concluída.');
    } catch (e) {
      console.log('ℹ️ Ignorando migração de link_pdf (talvez a coluna não exista):', e.message);
    }

    console.log('=== Atualização v9 finalizada com sucesso. ===');
  } catch (e) {
    console.error('❌ Falha na atualização v9:', e);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();