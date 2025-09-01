// src/migrations/20250901224000-add-dars-data-pagamento.js
"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("dars");
    if (!table.data_pagamento) {
      await queryInterface.addColumn("dars", "data_pagamento", {
        // Em SQLite, DATE vira TEXT (ISO 8601). No Sequelize você pode usar DATE sem problemas.
        type: Sequelize.DATE,
        allowNull: true,
      });
      try {
        await queryInterface.addIndex("dars", ["data_pagamento"], {
          name: "idx_dars_data_pagamento",
        });
      } catch (e) {
        console.log("[MIGRATE] idx_dars_data_pagamento: " + (e?.message || e));
      }
      console.log("[MIGRATE] dars.data_pagamento criada.");
    } else {
      console.log("[MIGRATE] dars.data_pagamento já existe — pulando.");
    }
  },

  async down(queryInterface/*, Sequelize */) {
    const table = await queryInterface.describeTable("dars");
    if (table.data_pagamento) {
      try { await queryInterface.removeIndex("dars", "idx_dars_data_pagamento"); } catch {}
      await queryInterface.removeColumn("dars", "data_pagamento");
      console.log("[MIGRATE][down] dars.data_pagamento removida.");
    }
  },
};
