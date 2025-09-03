'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['remarcacao_solicitada']) {
      await queryInterface.addColumn('Eventos', 'remarcacao_solicitada', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table['datas_evento_solicitada']) {
      await queryInterface.addColumn('Eventos', 'datas_evento_solicitada', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!table['data_aprovacao_remarcacao']) {
      await queryInterface.addColumn('Eventos', 'data_aprovacao_remarcacao', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'remarcacao_solicitada');
    await queryInterface.removeColumn('Eventos', 'datas_evento_solicitada');
    await queryInterface.removeColumn('Eventos', 'data_aprovacao_remarcacao');
  }
};

