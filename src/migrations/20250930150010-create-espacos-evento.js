'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('espacos_evento', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      nome: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      capacidade: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      area_m2: {
        type: Sequelize.REAL,
        allowNull: false,
        defaultValue: 0,
      },
      valor_diaria_1: {
        type: Sequelize.REAL,
        allowNull: false,
        defaultValue: 0,
      },
      valor_diaria_2: {
        type: Sequelize.REAL,
        allowNull: false,
        defaultValue: 0,
      },
      valor_diaria_3: {
        type: Sequelize.REAL,
        allowNull: false,
        defaultValue: 0,
      },
      valor_diaria_adicional: {
        type: Sequelize.REAL,
        allowNull: false,
        defaultValue: 0,
      },
      ativo: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      criado_em: {
        type: Sequelize.TEXT,
        defaultValue: Sequelize.literal("datetime('now')"),
      },
      atualizado_em: {
        type: Sequelize.TEXT,
        defaultValue: Sequelize.literal("datetime('now')"),
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('espacos_evento');
  },
};
