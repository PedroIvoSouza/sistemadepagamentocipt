'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Clientes_Eventos');
    const columns = [
      'cep',
      'logradouro',
      'numero',
      'complemento',
      'bairro',
      'cidade',
      'uf',
      'endereco'
    ];

    for (const name of columns) {
      if (!table[name]) {
        await queryInterface.addColumn('Clientes_Eventos', name, {
          type: Sequelize.TEXT,
          allowNull: true,
        });
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Clientes_Eventos', 'cep');
    await queryInterface.removeColumn('Clientes_Eventos', 'logradouro');
    await queryInterface.removeColumn('Clientes_Eventos', 'numero');
    await queryInterface.removeColumn('Clientes_Eventos', 'complemento');
    await queryInterface.removeColumn('Clientes_Eventos', 'bairro');
    await queryInterface.removeColumn('Clientes_Eventos', 'cidade');
    await queryInterface.removeColumn('Clientes_Eventos', 'uf');
    await queryInterface.removeColumn('Clientes_Eventos', 'endereco');
  }
};

