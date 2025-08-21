'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['evento_gratuito']) {
      await queryInterface.addColumn('Eventos', 'evento_gratuito', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table['justificativa_gratuito']) {
      await queryInterface.addColumn('Eventos', 'justificativa_gratuito', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'evento_gratuito');
    await queryInterface.removeColumn('Eventos', 'justificativa_gratuito');
  },
};

