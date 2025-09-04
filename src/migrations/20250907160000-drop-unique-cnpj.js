'use strict';

/**
 * Remove a constraint UNIQUE from permissionarios.cnpj.
 * Rebuilds table without UNIQUE.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('PRAGMA foreign_keys = OFF;');

    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='permissionarios'
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela permissionarios não encontrada no sqlite_master.');
    }
    const createSql = rows[0].sql;

    const patchedCreateSql = createSql.replace(/cnpj\s+TEXT\s+NOT\s+NULL\s+UNIQUE/gi, 'cnpj TEXT NOT NULL');
    const createNewSql = patchedCreateSql.replace(/CREATE\s+TABLE\s+("?permissionarios"?)/i, 'CREATE TABLE permissionarios_new');
    await sequelize.query(createNewSql);

    const [oldCols] = await sequelize.query(`PRAGMA table_info(permissionarios);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(permissionarios_new);`);
    const common = newCols.map(c => c.name).filter(name => oldCols.find(o => o.name === name));
    const colList = common.map(c => `"${c}"`).join(', ');
    await sequelize.query(`INSERT INTO permissionarios_new (${colList}) SELECT ${colList} FROM permissionarios;`);

    await sequelize.query('DROP TABLE permissionarios;');
    await sequelize.query('ALTER TABLE permissionarios_new RENAME TO permissionarios;');
    await sequelize.query('PRAGMA foreign_keys = ON;');
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('PRAGMA foreign_keys = OFF;');

    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='permissionarios'
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela permissionarios não encontrada no sqlite_master.');
    }
    const createSql = rows[0].sql;

    const patchedCreateSql = createSql.replace(/cnpj\s+TEXT\s+NOT\s+NULL(?!\s+UNIQUE)/gi, 'cnpj TEXT NOT NULL UNIQUE');
    const createNewSql = patchedCreateSql.replace(/CREATE\s+TABLE\s+("?permissionarios"?)/i, 'CREATE TABLE permissionarios_new');
    await sequelize.query(createNewSql);

    const [oldCols] = await sequelize.query(`PRAGMA table_info(permissionarios);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(permissionarios_new);`);
    const common = newCols.map(c => c.name).filter(name => oldCols.find(o => o.name === name));
    const colList = common.map(c => `"${c}"`).join(', ');
    await sequelize.query(`INSERT INTO permissionarios_new (${colList}) SELECT ${colList} FROM permissionarios;`);

    await sequelize.query('DROP TABLE permissionarios;');
    await sequelize.query('ALTER TABLE permissionarios_new RENAME TO permissionarios;');
    await sequelize.query('PRAGMA foreign_keys = ON;');
  }
};
