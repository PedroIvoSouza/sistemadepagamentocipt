'use strict';

/**
 * Recria a tabela `dars` para ajustar o tipo da coluna `data_emissao`
 * e garantir a existência de `emitido_por_id` com chave estrangeira.
 *
 * - `data_emissao` passa a ser `DATE NULL DEFAULT NULL`.
 * - `emitido_por_id` referencia `permissionarios(id)` com
 *   `ON UPDATE CASCADE` e `ON DELETE SET NULL`.
 * - Dados existentes são copiados com `data_emissao` convertido para
 *   ISO 8601 ou `NULL` quando inválido.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='dars'
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela dars não encontrada no sqlite_master.');
    }

    let createSql = rows[0].sql;

    // Garantir definição desejada para data_emissao
    createSql = createSql.replace(
      /data_emissao\s+[^,]+/i,
      'data_emissao DATE NULL DEFAULT NULL'
    );

    // Garantir coluna emitido_por_id com chave estrangeira adequada
    if (/emitido_por_id/i.test(createSql)) {
      createSql = createSql.replace(
        /emitido_por_id\s+[^,\n]+/i,
        'emitido_por_id INTEGER REFERENCES permissionarios(id) ON UPDATE CASCADE ON DELETE SET NULL'
      );
    } else {
      createSql = createSql.replace(
        /(\n\s*)(FOREIGN KEY|CONSTRAINT)/i,
        ',\n  emitido_por_id INTEGER REFERENCES permissionarios(id) ON UPDATE CASCADE ON DELETE SET NULL\n$1$2'
      );
      if (!/emitido_por_id/i.test(createSql)) {
        createSql = createSql.replace(
          /\)\s*;?$/,
          ',\n  emitido_por_id INTEGER REFERENCES permissionarios(id) ON UPDATE CASCADE ON DELETE SET NULL\n)'
        );
      }
    }

    const createNewSql = createSql.replace(
      /CREATE\s+TABLE\s+("?dars"?)/i,
      'CREATE TABLE dars_new'
    );
    await sequelize.query(createNewSql);

    const [oldCols] = await sequelize.query(`PRAGMA table_info(dars);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(dars_new);`);
    const common = newCols
      .map(c => c.name)
      .filter(name => oldCols.find(o => o.name === name));

    const colList = common.map(c => `"${c}"`).join(', ');
    const selectCols = common
      .map(c =>
        c === 'data_emissao'
          ? `CASE WHEN julianday(data_emissao) IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', data_emissao) ELSE NULL END AS data_emissao`
          : `"${c}"`
      )
      .join(', ');

    await sequelize.query(
      `INSERT INTO dars_new (${colList}) SELECT ${selectCols} FROM dars;`
    );

    await sequelize.query('DROP TABLE dars;');
    await sequelize.query('ALTER TABLE dars_new RENAME TO dars;');

    await sequelize.query('PRAGMA foreign_keys = ON;');
  },

  async down() {
    console.log('[down] rebuild-dars-data-emissao-emitido-por-id: sem ação');
  }
};

