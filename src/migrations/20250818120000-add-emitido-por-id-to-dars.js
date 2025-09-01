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
      const [dars] = await queryInterface.sequelize.query(
        "SELECT id, data_emissao FROM dars"
      );

      for (const dar of dars) {
        if (dar.data_emissao) {
          const date = new Date(dar.data_emissao);
          if (isNaN(date.getTime())) {
            await queryInterface.bulkUpdate(
              'dars',
              { data_emissao: null },
              { id: dar.id }
            );
          } else {
            await queryInterface.bulkUpdate(
              'dars',
              { data_emissao: date.toISOString() },
              { id: dar.id }
            );
          }
        }
      }

      await queryInterface.changeColumn('dars', 'data_emissao', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('dars');
    if (table['emitido_por_id']) {
      await queryInterface.removeColumn('dars', 'emitido_por_id');
    }
    await queryInterface.changeColumn('dars', 'data_emissao', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    });
  }
};
