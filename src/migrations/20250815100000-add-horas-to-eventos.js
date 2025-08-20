'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['hora_inicio']) {
      await queryInterface.addColumn('Eventos', 'hora_inicio', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table['hora_fim']) {
      await queryInterface.addColumn('Eventos', 'hora_fim', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table['hora_montagem']) {
      await queryInterface.addColumn('Eventos', 'hora_montagem', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table['hora_desmontagem']) {
      await queryInterface.addColumn('Eventos', 'hora_desmontagem', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'hora_inicio');
    await queryInterface.removeColumn('Eventos', 'hora_fim');
    await queryInterface.removeColumn('Eventos', 'hora_montagem');
    await queryInterface.removeColumn('Eventos', 'hora_desmontagem');
  }
};
