// Torna dars.permissionario_id, mes_referencia e ano_referencia NULLABLE preservando dados.
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

const db = new sqlite3.Database(DB_PATH);

// helpers com parênteses corretos
const get = (sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (e, r) => (e ? rej(e) : res(r)))
);
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r)))
);
const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function (e) { return e ? rej(e) : res(this); })
);

(async () => {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='dars';");
    if (!row || !row.sql) throw new Error('Não encontrei CREATE TABLE dars no sqlite_master.');
    const originalCreate = row.sql;

    // Remove "NOT NULL" apenas das colunas alvo (mantém tipo/PK/FKs)
    const relax = (sql, col) =>
      sql.replace(
        new RegExp(`(\\b${col}\\b\\s+[A-Z]+(?:\\s*\\(\\d+\\))?\\s*)(NOT\\s+NULL\\s*)`, 'i'),
        (_m, p1) => p1
      );

    let replaced = originalCreate;
    ['permissionario_id', 'mes_referencia', 'ano_referencia'].forEach(c => {
      replaced = relax(replaced, c);
    });

    if (replaced === originalCreate) {
      console.log('Nada para alterar (já é NULLABLE ou colunas sem NOT NULL).');
      process.exit(0);
    }

    // nomes de colunas para copiar 1:1
    const cols = await all("PRAGMA table_info(dars);");
    const colNames = cols.map(c => c.name).join(',');

    await run('PRAGMA foreign_keys = OFF;');
    await run('BEGIN;');

    // renomeia tabela antiga
    await run(`ALTER TABLE dars RENAME TO dars__backup_evt;`);

    // recria com NOT NULL removido
    const createNew = replaced.replace(/CREATE\s+TABLE\s+(\S+)/i, 'CREATE TABLE dars');
    await run(createNew);

    // copia dados
    await run(`INSERT INTO dars (${colNames}) SELECT ${colNames} FROM dars__backup_evt;`);

    // descarta backup
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
