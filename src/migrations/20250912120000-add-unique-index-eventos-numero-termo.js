'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Remove duplicated numero_termo keeping the lowest rowid
    await queryInterface.sequelize.query(`
      DELETE FROM Eventos
      WHERE numero_termo IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid)
          FROM Eventos
          WHERE numero_termo IS NOT NULL
          GROUP BY numero_termo
        );
    `);

    // Create unique index to enforce uniqueness
    await queryInterface.addIndex('Eventos', ['numero_termo'], {
      name: 'ux_eventos_numero_termo',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Eventos', 'ux_eventos_numero_termo');
  },
};
