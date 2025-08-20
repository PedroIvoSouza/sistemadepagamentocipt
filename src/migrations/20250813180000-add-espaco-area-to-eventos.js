'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['espaco_utilizado']) {
      await queryInterface.addColumn('Eventos', 'espaco_utilizado', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table['area_m2']) {
      await queryInterface.addColumn('Eventos', 'area_m2', {
        type: Sequelize.FLOAT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'espaco_utilizado');
    await queryInterface.removeColumn('Eventos', 'area_m2');
  }
};
