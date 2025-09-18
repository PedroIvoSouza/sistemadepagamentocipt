'use strict';

async function getCreateTableSql(sequelize, tableName) {
  const [rows] = await sequelize.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`
  );
  if (!rows || !rows.length || !rows[0].sql) {
    throw new Error(`Não foi possível obter o SQL de criação da tabela ${tableName}.`);
  }
  return rows[0].sql;
}

async function getIndexDefinitions(sequelize, tableName) {
  const [rows] = await sequelize.query(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${tableName}' AND sql IS NOT NULL`
  );
  return rows || [];
}

function buildCreateTableSql(baseSql, newTableName, referencedTableName) {
  const withTableName = baseSql.replace(
    /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(["'`]?)(DARs_Eventos)\2/i,
    (_, ifNotExists = '', quote = '') => `CREATE TABLE ${ifNotExists || ''}${quote}${newTableName}${quote}`
  );

  return withTableName
    .replace(/REFERENCES\s+(["'`]?)(Eventos_old)\1/gi, `REFERENCES ${referencedTableName}`)
    .replace(/REFERENCES\s+(["'`]?)(Eventos)\1/gi, `REFERENCES ${referencedTableName}`);
}

function normalizeIndexSql(sql, tableName) {
  return sql.replace(/ON\s+(["'`]?)(DARs_Eventos)\1/gi, `ON ${tableName}`);
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    try {
      const [fkRows] = await sequelize.query(`PRAGMA foreign_key_list('DARs_Eventos');`);
      const needsRewrite = Array.isArray(fkRows)
        && fkRows.some(row => String(row.table || '').toLowerCase() === 'eventos_old');

      if (!needsRewrite) {
        return;
      }

      const originalCreateSql = await getCreateTableSql(sequelize, 'DARs_Eventos');
      const tmpCreateSql = buildCreateTableSql(originalCreateSql, 'DARs_Eventos_tmp', 'Eventos');

      await sequelize.query(tmpCreateSql);

      const indexes = await getIndexDefinitions(sequelize, 'DARs_Eventos');

      const [columns] = await sequelize.query(`PRAGMA table_info('DARs_Eventos');`);
      const columnList = columns.map(col => `"${col.name}"`).join(', ');
      if (columnList) {
        await sequelize.query(`INSERT INTO DARs_Eventos_tmp (${columnList}) SELECT ${columnList} FROM DARs_Eventos;`);
      }

      await sequelize.query('DROP TABLE DARs_Eventos;');
      await sequelize.query('ALTER TABLE DARs_Eventos_tmp RENAME TO DARs_Eventos;');

      for (const index of indexes) {
        if (!index.sql) continue;
        const indexSql = normalizeIndexSql(index.sql, 'DARs_Eventos');
        await sequelize.query(indexSql);
      }
    } finally {
      await sequelize.query('PRAGMA foreign_keys = ON;');
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    try {
      const [fkRows] = await sequelize.query(`PRAGMA foreign_key_list('DARs_Eventos');`);
      const needsRollback = Array.isArray(fkRows)
        && fkRows.some(row => String(row.table || '').toLowerCase() === 'eventos');

      if (!needsRollback) {
        return;
      }

      const currentCreateSql = await getCreateTableSql(sequelize, 'DARs_Eventos');
      const rollbackCreateSql = buildCreateTableSql(currentCreateSql, 'DARs_Eventos', 'Eventos_old');
      const indexes = await getIndexDefinitions(sequelize, 'DARs_Eventos');

      await sequelize.query('ALTER TABLE DARs_Eventos RENAME TO DARs_Eventos_fix;');
      await sequelize.query(rollbackCreateSql);

      const [oldColumns] = await sequelize.query(`PRAGMA table_info('DARs_Eventos_fix');`);
      const [newColumns] = await sequelize.query(`PRAGMA table_info('DARs_Eventos');`);
      const commonColumns = newColumns
        .map(col => col.name)
        .filter(name => oldColumns.find(old => old.name === name));
      if (commonColumns.length) {
        const columnList = commonColumns.map(name => `"${name}"`).join(', ');
        await sequelize.query(`INSERT INTO DARs_Eventos (${columnList}) SELECT ${columnList} FROM DARs_Eventos_fix;`);
      }

      await sequelize.query('DROP TABLE DARs_Eventos_fix;');

      for (const index of indexes) {
        if (!index.sql) continue;
        const indexSql = normalizeIndexSql(index.sql, 'DARs_Eventos');
        await sequelize.query(indexSql);
      }
    } finally {
      await sequelize.query('PRAGMA foreign_keys = ON;');
    }
  },
};
