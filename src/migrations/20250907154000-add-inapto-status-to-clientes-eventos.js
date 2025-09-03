'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Clientes_Eventos');
    if (!table['inapto_ate']) {
      await queryInterface.addColumn('Clientes_Eventos', 'inapto_ate', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!table['status_cliente']) {
      await queryInterface.addColumn('Clientes_Eventos', 'status_cliente', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Clientes_Eventos', 'inapto_ate');
    await queryInterface.removeColumn('Clientes_Eventos', 'status_cliente');
  }
};

