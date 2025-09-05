'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Clientes_Eventos');
    if (!table['token_definir_senha_expires']) {
      await queryInterface.sequelize.query(
        'ALTER TABLE Clientes_Eventos ADD COLUMN token_definir_senha_expires INTEGER'
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Clientes_Eventos', 'token_definir_senha_expires');
  }
};
