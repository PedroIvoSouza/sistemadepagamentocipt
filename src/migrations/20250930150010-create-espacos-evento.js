'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS espacos_evento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        capacidade INTEGER NOT NULL DEFAULT 0,
        area_m2 REAL NOT NULL DEFAULT 0,
        valor_diaria_1 REAL NOT NULL DEFAULT 0,
        valor_diaria_2 REAL NOT NULL DEFAULT 0,
        valor_diaria_3 REAL NOT NULL DEFAULT 0,
        valor_diaria_adicional REAL NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        criado_em TEXT DEFAULT (datetime('now')),
        atualizado_em TEXT DEFAULT (datetime('now'))
      );
    `);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP TABLE IF EXISTS espacos_evento;');
  },
};
