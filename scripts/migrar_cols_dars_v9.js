const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
console.log('=== Migração (v9) — adicionando colunas se faltarem ===');
console.log('DB:', DB_PATH);

const db = new sqlite3.Database(DB_PATH);

function addColumnIfMissing(table, column, type) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) { console.error(`Erro PRAGMA ${table}:`, err.message); return resolve(); }
      const exists = rows.some(r => r.name === column);
      if (exists) { console.log(`ℹ️  ${table}.${column} já existe.`); return resolve(); }
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (e) => {
        if (e) console.error(`Erro ao adicionar ${table}.${column}:`, e.message);
        else console.log(`✅ ${table}.${column} criado.`);
        resolve();
      });
    });
  });
}

(async () => {
  await addColumnIfMissing('dars', 'numero_documento', 'TEXT');
  await addColumnIfMissing('dars', 'pdf_url', 'TEXT');
  await addColumnIfMissing('permissionarios', 'numero_documento', 'TEXT');
  db.close(() => console.log('=== Migração finalizada. ==='));
})();