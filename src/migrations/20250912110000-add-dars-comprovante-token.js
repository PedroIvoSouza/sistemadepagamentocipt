// src/migrations/20250912110000-add-dars-comprovante-token.js
"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("dars");
    if (!table.comprovante_token) {
      await queryInterface.addColumn("dars", "comprovante_token", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
      console.log("[MIGRATE] dars.comprovante_token criada.");
    } else {
      console.log("[MIGRATE] dars.comprovante_token já existe — pulando.");
    }
  },

  async down(queryInterface /*, Sequelize */) {
    const table = await queryInterface.describeTable("dars");
    if (table.comprovante_token) {
      await queryInterface.removeColumn("dars", "comprovante_token");
      console.log("[MIGRATE][down] dars.comprovante_token removida.");
    }
  },
};

