'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = ON;');

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS dar_baixa_solicitacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dar_id INTEGER NOT NULL,
        permissionario_id INTEGER NOT NULL,
        solicitado_por_tipo TEXT NOT NULL,
        solicitado_por_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pendente',
        data_pagamento TEXT,
        guia_token TEXT,
        comprovante_token TEXT,
        admin_id INTEGER,
        admin_observacao TEXT,
        resposta_em TEXT,
        criado_em TEXT DEFAULT (datetime('now')),
        atualizado_em TEXT DEFAULT (datetime('now')),
        FOREIGN KEY(dar_id) REFERENCES dars(id) ON DELETE CASCADE,
        FOREIGN KEY(permissionario_id) REFERENCES permissionarios(id)
      );
    `);

    const columns = await sequelize.query(`PRAGMA table_info(dar_baixa_solicitacoes);`);
    const names = new Set((columns?.[0] || []).map((c) => String(c.name).toLowerCase()));

    const ensureColumn = async (name, ddl) => {
      if (!names.has(name.toLowerCase())) {
        await sequelize.query(`ALTER TABLE dar_baixa_solicitacoes ADD COLUMN ${ddl};`);
      }
    };

    await ensureColumn('admin_observacao', 'admin_observacao TEXT');
    await ensureColumn('resposta_em', "resposta_em TEXT");
    await ensureColumn('atualizado_em', "atualizado_em TEXT DEFAULT (datetime('now'))");
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP TABLE IF EXISTS dar_baixa_solicitacoes;');
  },
};

