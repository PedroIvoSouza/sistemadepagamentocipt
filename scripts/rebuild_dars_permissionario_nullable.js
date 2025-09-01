// Reconstrói a tabela dars a partir do schema efetivo (PRAGMA), tornando
// permissionario_id, mes_referencia e ano_referencia NULLABLE sem perder dados.
// Mantém tipos, defaults, PKs e TODAS as FKs originais.
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

const db = new sqlite3.Database(DB_PATH);

const Q = {
  get: (sql, p=[]) => new Promise((res, rej) => db.get(sql, p, (e, r)=> e?rej(e):res(r))),
  all: (sql, p=[]) => new Promise((res, rej) => db.all(sql, p, (e, r)=> e?rej(e):res(r))),
  run: (sql, p=[]) => new Promise((res, rej) => db.run(sql, p, function(e){ e?rej(e):res(this); })),
};

const TARGET_NULLABLE = new Set(['permissionario_id','mes_referencia','ano_referencia']);

(async () => {
  try {
    // 1) Ler definição efetiva
    const cols = await Q.all("PRAGMA table_info(dars);"); // cid,name,type,notnull,dflt_value,pk
    if (!cols || cols.length === 0) throw new Error("Tabela dars não encontrada.");
    const fks  = await Q.all("PRAGMA foreign_key_list(dars);"); // id,seq,table,from,to,on_update,on_delete,match

    // Ver se há algo a alterar
    const needChange = cols.some(c => TARGET_NULLABLE.has(c.name) && c.notnull === 1);
    if (!needChange) {
      console.log("Nada para alterar (já está NULLABLE ou colunas ausentes).");
      process.exit(0);
    }

    // 2) Montar CREATE TABLE novo a partir do PRAGMA, alterando notnull das 3 colunas
    const colDefs = cols.map(c => {
      const parts = [];
      parts.push(JSON.stringify(c.name).slice(1,-1)); // nome "cru" sem aspas
      if (c.type && c.type.trim()) parts.push(c.type.trim()); // tipo
      // NOT NULL apenas se NÃO for uma das colunas-alvo
      const makeNullable = TARGET_NULLABLE.has(c.name) ? 0 : c.notnull;
      if (makeNullable === 1) parts.push('NOT NULL');
      if (c.dflt_value !== null && c.dflt_value !== undefined) {
        // dflt_value já vem pronto (pode ter aspas ou funções)
        parts.push('DEFAULT ' + c.dflt_value);
      }
      if (c.pk === 1) parts.push('PRIMARY KEY');
      return parts.join(' ');
    });

    // 3) Constraints de FK (copiar todas)
    // group by fk id
    const fkGroups = {};
    for (const fk of fks) {
      if (!fkGroups[fk.id]) fkGroups[fk.id] = [];
      fkGroups[fk.id].push(fk);
    }
    const fkClauses = Object.values(fkGroups).map(group => {
      // pode haver FK multi-coluna
      const fromCols = group.map(g => g.from).join(', ');
      const toCols   = group.map(g => g.to).join(', ');
      const t        = group[0].table;
      let clause = `FOREIGN KEY(${fromCols}) REFERENCES ${t}(${toCols})`;
      if (group[0].on_update && group[0].on_update.toUpperCase() !== 'NO ACTION') {
        clause += ` ON UPDATE ${group[0].on_update}`;
      }
      if (group[0].on_delete && group[0].on_delete.toUpperCase() !== 'NO ACTION') {
        clause += ` ON DELETE ${group[0].on_delete}`;
      }
      if (group[0].match && group[0].match.toUpperCase() !== 'NONE') {
        clause += ` MATCH ${group[0].match}`;
      }
      return clause;
    });

    const createSQL = `CREATE TABLE dars (\n  ${[...colDefs, ...fkClauses].join(',\n  ')}\n);`;

    // 4) Rebuild seguro
    await Q.run('PRAGMA foreign_keys = OFF;');
    await Q.run('BEGIN;');

    await Q.run(`ALTER TABLE dars RENAME TO dars__backup_evt;`);
    await Q.run(createSQL);

    const colNames = cols.map(c => c.name).join(', ');
    await Q.run(`INSERT INTO dars (${colNames}) SELECT ${colNames} FROM dars__backup_evt;`);
    await Q.run(`DROP TABLE dars__backup_evt;`);

    await Q.run('COMMIT;');
    await Q.run('PRAGMA foreign_keys = ON;');

    console.log('OK: dars.permissionario_id/mes_referencia/ano_referencia agora são NULLABLE.');
  } catch (e) {
    console.error('Falha ao reconstruir dars:', e.message);
    try { await Q.run('ROLLBACK;'); } catch {}
    process.exit(1);
  } finally {
    db.close();
  }
})();
