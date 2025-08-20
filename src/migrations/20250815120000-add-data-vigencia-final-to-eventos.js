'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['data_vigencia_final']) {
      await queryInterface.addColumn('Eventos', 'data_vigencia_final', {
        type: Sequelize.DATEONLY,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'data_vigencia_final');
  }
};
