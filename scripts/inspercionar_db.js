// scripts/inspecionar_db.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve('./sistemacipt.db');

console.log('Inspecionando DB:', DB_PATH);
const db = new sqlite3.Database(DB_PATH);

function listCols(table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

(async () => {
  const dars = await listCols('dars');
  const perms = await listCols('permissionarios');
  console.log('\n[dars] colunas:');
  dars.forEach(c => console.log(` - ${c.name} (${c.type})`));
  console.log('\n[permissionarios] colunas:');
  perms.forEach(c => console.log(` - ${c.name} (${c.type})`));
  db.close();
})();