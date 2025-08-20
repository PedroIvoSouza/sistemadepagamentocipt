'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['numero_processo']) {
      await queryInterface.addColumn('Eventos', 'numero_processo', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table['numero_termo']) {
      await queryInterface.addColumn('Eventos', 'numero_termo', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Eventos');
    if (table['numero_processo']) {
      await queryInterface.removeColumn('Eventos', 'numero_processo');
    }
    if (table['numero_termo']) {
      await queryInterface.removeColumn('Eventos', 'numero_termo');
    }
  }
};
