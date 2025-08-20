'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Eventos', 'espaco_utilizado', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('Eventos', 'area_m2', {
      type: Sequelize.FLOAT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'espaco_utilizado');
    await queryInterface.removeColumn('Eventos', 'area_m2');
  }
};
