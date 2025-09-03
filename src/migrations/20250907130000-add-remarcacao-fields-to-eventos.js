'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['remarcado']) {
      await queryInterface.addColumn('Eventos', 'remarcado', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table['datas_evento_original']) {
      await queryInterface.addColumn('Eventos', 'datas_evento_original', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!table['data_pedido_remarcacao']) {
      await queryInterface.addColumn('Eventos', 'data_pedido_remarcacao', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'remarcado');
    await queryInterface.removeColumn('Eventos', 'datas_evento_original');
    await queryInterface.removeColumn('Eventos', 'data_pedido_remarcacao');
  }
};

