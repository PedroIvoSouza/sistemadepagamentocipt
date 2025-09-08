'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const fks = await queryInterface.getForeignKeyReferencesForTable('Advertencias');
    for (const fk of fks) {
      if (fk.columnName === 'cliente_id' && fk.constraintName) {
        await queryInterface.removeConstraint('Advertencias', fk.constraintName);
      }
    }

    await queryInterface.changeColumn('Advertencias', 'cliente_id', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: {
        model: 'Clientes_Eventos',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
  },

  async down(queryInterface, Sequelize) {
    const fks = await queryInterface.getForeignKeyReferencesForTable('Advertencias');
    for (const fk of fks) {
      if (fk.columnName === 'cliente_id' && fk.constraintName) {
        await queryInterface.removeConstraint('Advertencias', fk.constraintName);
      }
    }

    await queryInterface.changeColumn('Advertencias', 'cliente_id', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: {
        model: 'Clientes_Eventos',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
  }
};
