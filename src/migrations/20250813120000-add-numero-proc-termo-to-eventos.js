'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Eventos', 'numero_processo', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('Eventos', 'numero_termo', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'numero_processo');
    await queryInterface.removeColumn('Eventos', 'numero_termo');
  }
};
