'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = ON;');

    const [tableExists] = await sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dar_conciliacoes' LIMIT 1;"
    );

    if (Array.isArray(tableExists) && tableExists.length) {
      return;
    }

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS dar_conciliacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_execucao TEXT NOT NULL,
        data_referencia TEXT NOT NULL,
        iniciou_em TEXT,
        finalizou_em TEXT,
        duracao_ms INTEGER,
        total_pagamentos INTEGER DEFAULT 0,
        total_atualizados INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'sucesso' CHECK(status IN ('sucesso','falha')),
        mensagem TEXT
      );
    `);

    await sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_dar_conciliacoes_data_ref ON dar_conciliacoes(data_referencia);'
    );
    await sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_dar_conciliacoes_execucao ON dar_conciliacoes(data_execucao DESC);'
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP TABLE IF EXISTS dar_conciliacoes;');
  }
};
