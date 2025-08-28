'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('dars');
    if (!table['data_emissao']) {
      await queryInterface.addColumn('dars', 'data_emissao', {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('dars', 'data_emissao');
  }
};
