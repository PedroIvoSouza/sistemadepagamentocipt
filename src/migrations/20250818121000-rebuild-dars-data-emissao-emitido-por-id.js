// src/migrations/20250818121000-rebuild-dars-data-emissao-emitido-por-id.js
"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Só crie se NÃO existir
    const exists = await queryInterface
      .describeTable("dars")
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      await queryInterface.createTable("dars", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        permissionario_id: { type: Sequelize.INTEGER, allowNull: false },
        mes_referencia: { type: Sequelize.INTEGER },
        ano_referencia: { type: Sequelize.INTEGER },
        valor: { type: Sequelize.DECIMAL(10,2) },
        data_vencimento: { type: Sequelize.DATE },
        status: { type: Sequelize.STRING },
        data_emissao: { type: Sequelize.DATE },
        codigo_barras: { type: Sequelize.STRING },
        link_pdf: { type: Sequelize.STRING },
        numero_documento: { type: Sequelize.STRING },
        pdf_url: { type: Sequelize.STRING },
        // NÃO coloque linha_digitavel aqui — vamos adicionar em migração própria
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("datetime","now") },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("datetime","now") },
      });
    } else {
      console.log("[MIGRATE] 'dars' já existe — pulando criação.");
    }

    // … mantenha aqui o que for APENAS de dados (backfills / updates) e operações que
    // não recriem a tabela. Evite DROP/CREATE em SQLite.
  },

  async down(queryInterface/*, Sequelize */) {
    // Down seguro: não derrube a tabela se já está em produção.
    // Se realmente precisar, proteja com checagem:
    const exists = await queryInterface
      .describeTable("dars")
      .then(() => true)
      .catch(() => false);
    if (exists) {
      console.log("[MIGRATE][down] skip para 'dars' (produção).");
    }
  },
};
