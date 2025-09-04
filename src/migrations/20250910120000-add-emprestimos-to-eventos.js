'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Eventos');
    if (!table['emprestimo_tvs']) {
      await queryInterface.addColumn('Eventos', 'emprestimo_tvs', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table['emprestimo_caixas_som']) {
      await queryInterface.addColumn('Eventos', 'emprestimo_caixas_som', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table['emprestimo_microfones']) {
      await queryInterface.addColumn('Eventos', 'emprestimo_microfones', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Eventos', 'emprestimo_tvs');
    await queryInterface.removeColumn('Eventos', 'emprestimo_caixas_som');
    await queryInterface.removeColumn('Eventos', 'emprestimo_microfones');
  }
};
