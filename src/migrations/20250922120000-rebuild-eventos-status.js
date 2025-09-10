'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='Eventos';
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela Eventos não encontrada no sqlite_master.');
    }

    const createSql = rows[0].sql;
    const patchedCreateSql = createSql.replace(
      /status\s+TEXT[^,]*CHECK\s*\(status\s+IN\s*\([^\)]*\)\)/i,
      "status TEXT NOT NULL DEFAULT 'Pendente' CHECK(status IN ('Pendente','Emitido','Reemitido','Parcialmente Pago','Pago','Realizado','Cancelado'))"
    );

    await sequelize.query('ALTER TABLE Eventos RENAME TO Eventos_old;');

    const createNewSql = patchedCreateSql.replace(/CREATE\s+TABLE\s+("?Eventos"?)/i, 'CREATE TABLE Eventos');
    await sequelize.query(createNewSql);

    const [oldCols] = await sequelize.query(`PRAGMA table_info(Eventos_old);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(Eventos);`);
    const common = newCols.map(c => c.name).filter(name => oldCols.find(o => o.name === name));
    const withoutStatus = common.filter(name => name !== 'status');
    const colList = withoutStatus.map(c => `"${c}"`).join(', ');

    await sequelize.query(`
      INSERT INTO Eventos (${colList}, status)
      SELECT ${colList}, CASE WHEN status='Pago Parcialmente' THEN 'Parcialmente Pago' ELSE status END
      FROM Eventos_old;
    `);

    await sequelize.query('DROP TABLE Eventos_old;');

    await queryInterface.addIndex('Eventos', ['numero_termo'], {
      name: 'ux_eventos_numero_termo',
      unique: true,
    });

    await sequelize.query('PRAGMA foreign_keys = ON;');
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='Eventos';
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela Eventos não encontrada no sqlite_master.');
    }

    const createSql = rows[0].sql;
    const patchedCreateSql = createSql.replace(
      /status\s+TEXT[^,]*CHECK\s*\(status\s+IN\s*\([^\)]*\)\)/i,
      "status TEXT NOT NULL DEFAULT 'Pendente' CHECK(status IN ('Pendente','Emitido','Reemitido','Pago Parcialmente','Pago','Realizado','Cancelado'))"
    );

    await sequelize.query('ALTER TABLE Eventos RENAME TO Eventos_old;');

    const createNewSql = patchedCreateSql.replace(/CREATE\s+TABLE\s+("?Eventos"?)/i, 'CREATE TABLE Eventos');
    await sequelize.query(createNewSql);

    const [oldCols] = await sequelize.query(`PRAGMA table_info(Eventos_old);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(Eventos);`);
    const common = newCols.map(c => c.name).filter(name => oldCols.find(o => o.name === name));
    const withoutStatus = common.filter(name => name !== 'status');
    const colList = withoutStatus.map(c => `"${c}"`).join(', ');

    await sequelize.query(`
      INSERT INTO Eventos (${colList}, status)
      SELECT ${colList}, CASE WHEN status='Parcialmente Pago' THEN 'Pago Parcialmente' ELSE status END
      FROM Eventos_old;
    `);

    await sequelize.query('DROP TABLE Eventos_old;');

    await queryInterface.addIndex('Eventos', ['numero_termo'], {
      name: 'ux_eventos_numero_termo',
      unique: true,
    });

    await sequelize.query('PRAGMA foreign_keys = ON;');
  }
};
