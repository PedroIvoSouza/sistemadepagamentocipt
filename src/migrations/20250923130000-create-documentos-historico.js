"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    await qi.sequelize.transaction(async (t) => {
      await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS documentos_historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documento_id INTEGER,
        token TEXT,
        evento_id INTEGER,
        status TEXT,
        created_at TEXT
      );`, { transaction: t });
    });
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    await qi.sequelize.transaction(async (t) => {
      await qi.sequelize.query(`DROP TABLE IF EXISTS documentos_historico;`, { transaction: t });
    });
  }
};
