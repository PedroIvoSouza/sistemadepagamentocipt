'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('dars');
    if (!table['emitido_por_id']) {
      await queryInterface.addColumn('dars', 'emitido_por_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'permissionarios',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
    if (table['data_emissao']) {
      const columnType = table['data_emissao'].type || '';
      const isDate = columnType.toLowerCase().includes('date');

      if (!isDate) {
        await queryInterface.changeColumn('dars', 'data_emissao', {
          type: Sequelize.DATE,
          allowNull: true,
          defaultValue: null,
        });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('dars', 'emitido_por_id');
    await queryInterface.changeColumn('dars', 'data_emissao', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    });
  }
};
