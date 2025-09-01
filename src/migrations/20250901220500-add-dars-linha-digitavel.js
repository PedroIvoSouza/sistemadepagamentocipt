// src/migrations/20250901220500-add-dars-linha-digitavel.js
"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("dars");

    if (!table.linha_digitavel) {
      await queryInterface.addColumn("dars", "linha_digitavel", {
        type: Sequelize.STRING(100),
        allowNull: true,
      });
      // Backfill opcional: usa codigo_barras quando existir
      await queryInterface.sequelize.query(`
        UPDATE dars
           SET linha_digitavel = codigo_barras
         WHERE linha_digitavel IS NULL
           AND codigo_barras IS NOT NULL;
      `);
      console.log("[MIGRATE] dars.linha_digitavel criada e preenchida quando possível.");
    } else {
      console.log("[MIGRATE] dars.linha_digitavel já existe — pulando.");
    }
  },

  async down(queryInterface/*, Sequelize */) {
    const table = await queryInterface.describeTable("dars");
    if (table.linha_digitavel) {
      await queryInterface.removeColumn("dars", "linha_digitavel");
      console.log("[MIGRATE][down] dars.linha_digitavel removida.");
    }
  },
};
