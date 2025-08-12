'use strict';

/**
 * SQLite não altera NOT NULL com changeColumn.
 * Recria a tabela dars removendo NOT NULL de:
 * - permissionario_id
 * - mes_referencia
 * - ano_referencia
 * Copia os dados e renomeia.
 * Idempotente: se já estiver sem NOT NULL, o SQL final será o mesmo.
 */
module.exports = {
  async up(queryInterface) {
    const qi = queryInterface;
    const sequelize = qi.sequelize;

    await sequelize.query('PRAGMA foreign_keys = OFF;');

    const [rows] = await sequelize.query(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='dars'
    `);
    if (!rows || !rows[0] || !rows[0].sql) {
      throw new Error('Tabela dars não encontrada no sqlite_master.');
    }

    const createSql = rows[0].sql;

    // Remover NOT NULL dos campos alvo (case-insensitive, tolerante a espaços)
    const patchedCreateSql = createSql
      .replace(/permissionario_id\s+INTEGER\s+NOT\s+NULL/gi, 'permissionario_id INTEGER')
      .replace(/mes_referencia\s+INTEGER\s+NOT\s+NULL/gi, 'mes_referencia INTEGER')
      .replace(/ano_referencia\s+INTEGER\s+NOT\s+NULL/gi, 'ano_referencia INTEGER');

    // Criar tabela nova com o schema ajustado
    const createNewSql = patchedCreateSql
      .replace(/CREATE\s+TABLE\s+("?dars"?)/i, 'CREATE TABLE dars_new');
    await sequelize.query(createNewSql);

    // Colunas comuns para copiar dados
    const [oldCols] = await sequelize.query(`PRAGMA table_info(dars);`);
    const [newCols] = await sequelize.query(`PRAGMA table_info(dars_new);`);
    const common = newCols.map(c => c.name).filter(name => oldCols.find(o => o.name === name));
    const colList = common.map(c => `"${c}"`).join(', ');

    // Copiar dados
    await sequelize.query(`INSERT INTO dars_new (${colList}) SELECT ${colList} FROM dars;`);

    // Trocar tabelas
    await sequelize.query(`DROP TABLE dars;`);
    await sequelize.query(`ALTER TABLE dars_new RENAME TO dars;`);

    await sequelize.query('PRAGMA foreign_keys = ON;');
  },

  async down() {
    // Sem reversão (opcional). Para voltar, recriar com NOT NULL novamente.
    console.log('[down] rebuild-dars-nullables-for-events: no-op');
  }
};
