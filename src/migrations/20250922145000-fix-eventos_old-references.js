'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // util: pega DDL de uma tabela
    async function getCreateSql(table) {
      const [rows] = await sequelize.query(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=$table`,
        { bind: { table }, type: sequelize.QueryTypes.SELECT }
      );
      return rows?.sql || null;
    }

    // util: busca objetos que ainda citam Eventos_old
    async function findObjectsReferencingEventosOld() {
      const [rows] = await sequelize.query(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE sql LIKE '%Eventos_old%'`
      );
      return rows || [];
    }

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    try {
      // 1) Checa se DARs_Eventos referencia Eventos_old
      const ddlDARsEventos = await getCreateSql('DARs_Eventos');
      const needsFixDARsEventos =
        ddlDARsEventos && /REFERENCES\s+["'`]?Eventos_old["'`]?/i.test(ddlDARsEventos);

      if (needsFixDARsEventos) {
        // Recria DARs_Eventos apontando para Eventos
        await sequelize.query('ALTER TABLE DARs_Eventos RENAME TO DARs_Eventos_fix;');

        await sequelize.query(`
          CREATE TABLE DARs_Eventos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_evento INTEGER,
            id_dar INTEGER,
            numero_parcela INTEGER,
            created_at TEXT,
            updated_at TEXT,
            FOREIGN KEY (id_evento) REFERENCES Eventos(id) ON UPDATE CASCADE ON DELETE CASCADE,
            FOREIGN KEY (id_dar)    REFERENCES DARs(id)    ON UPDATE CASCADE ON DELETE CASCADE
          );
        `);

        await sequelize.query(`
          INSERT INTO DARs_Eventos (id, id_evento, id_dar, numero_parcela, created_at, updated_at)
          SELECT id, id_evento, id_dar, numero_parcela, created_at, updated_at
          FROM DARs_Eventos_fix;
        `);

        await sequelize.query('DROP TABLE DARs_Eventos_fix;');
      }

      // 2) Recria triggers/índices que ainda citem Eventos_old
      const offenders = await findObjectsReferencingEventosOld();
      for (const obj of offenders) {
        if (!obj.sql) continue;

        // DROP seguro
        if (obj.type === 'index') {
          await sequelize.query(`DROP INDEX IF EXISTS "${obj.name}";`);
        } else if (obj.type === 'trigger') {
          await sequelize.query(`DROP TRIGGER IF EXISTS "${obj.name}";`);
        } else {
          // se for 'table', não vamos mexer de forma genérica aqui (já cobrimos DARs_Eventos)
          continue;
        }

        // recria trocando Eventos_old -> Eventos
        const fixed = obj.sql.replace(/Eventos_old/gi, 'Eventos');
        await sequelize.query(fixed);
      }
    } finally {
      await sequelize.query('PRAGMA foreign_keys = ON;');
    }
  }
};
