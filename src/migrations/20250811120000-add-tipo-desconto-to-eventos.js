'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['tipo_desconto']) {
      await queryInterface.addColumn('Eventos', 'tipo_desconto', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'tipo_desconto');
  }
};