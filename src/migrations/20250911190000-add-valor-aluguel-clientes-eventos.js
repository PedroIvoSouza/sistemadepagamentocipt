'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Clientes_Eventos', 'valor_aluguel', {
      type: Sequelize.REAL,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Clientes_Eventos', 'valor_aluguel');
  }
};
