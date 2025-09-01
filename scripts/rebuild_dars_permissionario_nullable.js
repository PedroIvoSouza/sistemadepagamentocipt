// scripts/rebuild_dars_permissionario_nullable.js
// Deixa dars.permissionario_id, mes_referencia e ano_referencia como NULLABLE preservando dados.
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

const db = new sqlite3.Database(DB_PATH);

function get(sql, p=[]) { return new Promise((res, rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)); }
function all(sql, p=[]) { return new Promise((res, rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)); }
function run(sql, p=[]) { return new Promise((res, rej)=>db.run(sql,p,function(e){e?rej(e):res(this)})); }

(async () => {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='dars';");
    if (!row || !row.sql) throw new Error('Não encontrei CREATE TABLE dars no sqlite_master.');
    let createSql = row.sql;

    // Função que remove "NOT NULL" dos campos alvo (mantendo tipo e demais constraints)
    const relax = (sql, col) =>
      sql.replace(
        new RegExp(`(\\b${col}\\b\\s+[A-Z]+(?:\\s*\\(\\d+\\))?\\s*)(NOT\\s+NULL\\s*)`, 'i'),
        (_m, p1) => p1
      );

    // Remover NOT NULL de permissionario_id, mes_referencia, ano_referencia (se existirem)
    let replaced = createSql;
    ['permissionario_id','mes_referencia','ano_referencia'].forEach(c => { replaced = relax(replaced, c); });

    if (replaced === createSql) {
      console.log('Nada para alterar (já está NULLABLE ou colunas não têm NOT NULL).');
      process.exit(0);
    }

    // Descobrir colunas atuais para copiar 1:1
    const cols = await all("PRAGMA table_info(dars);");
    const colNames = cols.map(c => c.name).join(',');

    await run('PRAGMA foreign_keys = OFF;');
    await run('BEGIN;');

    // Renomeia a tabela antiga e recria a nova com o SQL ajustado
    await run(`ALTER TABLE dars RENAME TO dars__backup_evt;`);
    // Troca o nome da tabela no CREATE para dars
    const createNew = replaced.replace(/CREATE\s+TABLE\s+(\S+)/i, 'CREATE TABLE dars');
    await run(createNew);
    await run(`INSERT INTO dars (${colNames}) SELECT ${colNames} FROM dars__backup_evt;`);
    await run(`DROP TABLE dars__backup_evt;`);

    await run('COMMIT;');
    await run('PRAGMA foreign_keys = ON;');

    console.log('OK: dars.permissionario_id/mes/ano agora são NULLABLE.');
  } catch (e) {
    console.error('Falha ao reconstruir dars:', e.message);
    try { await run('ROLLBACK;'); } catch {}
    process.exit(1);
  } finally {
    db.close();
  }
})();
