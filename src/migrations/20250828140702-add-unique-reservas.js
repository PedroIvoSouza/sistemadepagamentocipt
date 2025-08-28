'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex(
      'reservas_salas',
      ['sala_id', 'data', 'hora_inicio', 'hora_fim'],
      {
        name: 'reservas_salas_unica',
        unique: true,
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('reservas_salas', 'reservas_salas_unica');
  },
};
