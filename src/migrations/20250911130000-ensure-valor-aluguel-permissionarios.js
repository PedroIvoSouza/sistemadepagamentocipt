'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('permissionarios');
    if (!table['valor_aluguel']) {
      await queryInterface.addColumn('permissionarios', 'valor_aluguel', {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('permissionarios', 'valor_aluguel');
  },
};
