"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("dars");
    if (!table.sem_juros) {
      await queryInterface.addColumn("dars", "sem_juros", {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
      await queryInterface.sequelize.query(`
        UPDATE dars
           SET sem_juros = 0
         WHERE sem_juros IS NULL;
      `);
      console.log("[MIGRATE] dars.sem_juros criado com default 0.");
    } else {
      console.log("[MIGRATE] dars.sem_juros já existe — pulando.");
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("dars");
    if (table.sem_juros) {
      await queryInterface.removeColumn("dars", "sem_juros");
      console.log("[MIGRATE][down] dars.sem_juros removido.");
    }
  },
};
