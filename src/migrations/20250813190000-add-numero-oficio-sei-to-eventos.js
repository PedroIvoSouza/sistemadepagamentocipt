'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['numero_oficio_sei']) {
      await queryInterface.addColumn('Eventos', 'numero_oficio_sei', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'numero_oficio_sei');
  }
};
