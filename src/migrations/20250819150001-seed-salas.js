'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert('salas_reuniao', [
      { numero: '116', capacidade: 15, status: 'disponivel' },
      { numero: '114', capacidade: 8, status: 'disponivel' },
      { numero: '214', capacidade: 15, status: 'disponivel' },
      { numero: '204', capacidade: 8, status: 'disponivel' },
      { numero: '314', capacidade: 15, status: 'disponivel' },
      { numero: '304', capacidade: 8, status: 'disponivel' },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('salas_reuniao', {
      numero: ['116', '114', '214', '204', '314', '304'],
    });
  },
};

