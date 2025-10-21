'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('PRAGMA foreign_keys = ON;');

    const [tableExists] = await sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dar_conciliacoes_pagamentos' LIMIT 1;"
    );

    if (Array.isArray(tableExists) && tableExists.length) {
      return;
    }

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS dar_conciliacoes_pagamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conciliacao_id INTEGER NOT NULL,
        dar_id INTEGER,
        status_anterior TEXT,
        status_atual TEXT,
        numero_documento TEXT,
        valor REAL,
        data_vencimento TEXT,
        data_pagamento TEXT,
        origem TEXT,
        contribuinte TEXT,
        documento_contribuinte TEXT,
        pagamento_guia TEXT,
        pagamento_documento TEXT,
        pagamento_valor REAL,
        pagamento_data TEXT,
        criado_em TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (conciliacao_id) REFERENCES dar_conciliacoes(id) ON DELETE CASCADE
      );
    `);

    await sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_dar_conc_pag_conciliacao ON dar_conciliacoes_pagamentos(conciliacao_id);'
    );
    await sequelize.query(
      'CREATE INDEX IF NOT EXISTS idx_dar_conc_pag_dar ON dar_conciliacoes_pagamentos(dar_id);'
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP TABLE IF EXISTS dar_conciliacoes_pagamentos;');
  }
};
