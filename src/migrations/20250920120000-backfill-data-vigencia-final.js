'use strict';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      `SELECT id, datas_evento FROM Eventos WHERE data_vigencia_final IS NULL OR data_vigencia_final = ''`
    );
    for (const row of rows) {
      let datas = [];
      try {
        const parsed = JSON.parse(row.datas_evento);
        if (Array.isArray(parsed)) datas = parsed;
      } catch (e) {
        if (row.datas_evento) {
          datas = String(row.datas_evento).split(/[,;\s]+/).filter(Boolean);
        }
      }
      if (!Array.isArray(datas) || datas.length === 0) continue;
      const ordenadas = datas.map((d) => new Date(d)).sort((a, b) => a - b);
      const max = ordenadas[ordenadas.length - 1];
      if (!max || isNaN(max)) continue;
      max.setDate(max.getDate() + 1);
      const iso = max.toISOString().slice(0, 10);
      await queryInterface.sequelize.query(
        `UPDATE Eventos SET data_vigencia_final = ? WHERE id = ?`,
        { replacements: [iso, row.id] }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE Eventos SET data_vigencia_final = NULL`
    );
  }
};
