'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['justificativa_remarcacao']) {
      await queryInterface.addColumn('Eventos', 'justificativa_remarcacao', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'justificativa_remarcacao');
  }
};
