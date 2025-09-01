'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('dars', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      permissionario_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'permissionarios',
          key: 'id',
        },
      },
      mes_referencia: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      ano_referencia: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      valor: {
        type: Sequelize.FLOAT,
        allowNull: false,
      },
      data_vencimento: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      data_emissao: {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      codigo_barras: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      link_pdf: {
        type: Sequelize.STRING,
        allowNull: true,
      },
    }, {
      uniqueKeys: {
        dars_unique_reference: {
          fields: ['permissionario_id', 'mes_referencia', 'ano_referencia'],
        },
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('dars');
  }
};
