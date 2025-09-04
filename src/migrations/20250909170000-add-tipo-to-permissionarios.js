'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('permissionarios');
    if (!table['tipo']) {
      await queryInterface.addColumn('permissionarios', 'tipo', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('permissionarios', 'tipo');
  },
};
