'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Clientes', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      nome_razao_social: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      documento: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      endereco: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      cep: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      email: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      telefone: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      logradouro: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      numero: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      complemento: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      bairro: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      cidade: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      uf: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Clientes');
  }
};
