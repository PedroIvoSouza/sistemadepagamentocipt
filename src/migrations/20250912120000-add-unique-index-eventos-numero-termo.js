'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Set numero_termo to NULL for duplicates, keeping the lowest rowid
    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT rowid, numero_termo,
               ROW_NUMBER() OVER (PARTITION BY numero_termo ORDER BY rowid) AS rn
        FROM Eventos
        WHERE numero_termo IS NOT NULL
      )
      UPDATE Eventos
      SET numero_termo = NULL
      WHERE rowid IN (SELECT rowid FROM ranked WHERE rn > 1);
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
