'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE dars SET status='Vencido' WHERE status='Vencida'"
    );
  },

  async down() {
    // Nenhuma ação necessária para reverter
  }
};
