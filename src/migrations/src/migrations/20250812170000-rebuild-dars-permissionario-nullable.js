'use strict';

/**
 * SQLite não altera NOT NULL com changeColumn.
 * Estratégia: recriar a tabela dars permitindo permissionario_id NULL,
 * copiar os dados e renomear.
 */
module.exports = {
  async up(queryInterface) {
    const qi = queryInterface;
    const sequelize = qi.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    // SQL atual da tabela dars
    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='dars'
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela dars não encontrada no sqlite_master.');
    }

    const createSql = rows[0].sql;

    // 1) Tornar permissionario_id NULL (remove NOT NULL)
    const patchedCreateSql = createSql
      .replace(/permissionario_id\s+INTEGER\s+NOT\s+NULL/gi, 'permissionario_id INTEGER');

    // 2) Criar tabela temporária com o schema ajustado
    const createNewSql = patchedCreateSql
      .replace(/CREATE\s+TABLE\s+("?dars"?)/i, 'CREATE TABLE dars_new');
    await sequelize.query(createNewSql);

    // 3) Descobrir colunas para copiar
    const [oldCols] = await sequelize.query(`PRAGMA table_info(dars);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(dars_new);`);
    const common = newCols
      .map(c => c.name)
      .filter(name => oldCols.find(o => o.name === name));

    // 4) Copiar dados
    const colList = common.map(c => `"${c}"`).join(', ');
    await sequelize.query(`INSERT INTO dars_new (${colList}) SELECT ${colList} FROM dars;`);

    // 5) Substituir tabelas
    await sequelize.query(`DROP TABLE dars;`);
    await sequelize.query(`ALTER TABLE dars_new RENAME TO dars;`);

    await sequelize.query('PRAGMA foreign_keys = ON;');
  },

  async down(queryInterface) {
    // Opcional: poderia reverter para NOT NULL, mas não é necessário.
    console.log('[down] rebuild-dars-permissionario-nullable: sem ação');
  }
};
