'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Advertencias', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      evento_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Eventos',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      cliente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clientes',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      texto_fatos: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      clausulas_json: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      gera_multa: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      valor_multa: {
        type: Sequelize.REAL,
        allowNull: true,
      },
      inapto_ate: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      prazo_recurso_dias: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      dar_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'dars',
          key: 'id',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      token: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      },
      pdf_url: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Advertencias');
  }
};

