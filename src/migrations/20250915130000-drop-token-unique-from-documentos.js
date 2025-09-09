"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    await qi.sequelize.transaction(async (t) => {
      // remove old unique index on token if present
      await qi.sequelize.query(`DROP INDEX IF EXISTS idx_documentos_token`, { transaction: t });
      // rename existing table
      await qi.sequelize.query(`ALTER TABLE documentos RENAME TO documentos_old;`, { transaction: t });
      // recreate table without unique token
      await qi.sequelize.query(`
        CREATE TABLE documentos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo TEXT NOT NULL,
          token TEXT,
          permissionario_id INTEGER,
          evento_id INTEGER,
          pdf_url TEXT,
          pdf_public_url TEXT,
          assinafy_id TEXT,
          status TEXT DEFAULT 'gerado',
          assinatura_url TEXT,
          signed_pdf_public_url TEXT,
          signed_at TEXT,
          signer TEXT,
          created_at TEXT
        );
      `, { transaction: t });
      await qi.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo);`, { transaction: t });
      await qi.sequelize.query(`
        INSERT OR REPLACE INTO documentos (
          id, tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url,
          assinafy_id, status, assinatura_url, signed_pdf_public_url, signed_at, signer, created_at
        )
        SELECT
          id, tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url,
          assinafy_id, status, assinatura_url, signed_pdf_public_url, signed_at, signer, created_at
        FROM documentos_old
        ORDER BY id;
      `, { transaction: t });
      await qi.sequelize.query(`DROP TABLE documentos_old;`, { transaction: t });
    });
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    await qi.sequelize.transaction(async (t) => {
      await qi.sequelize.query(`ALTER TABLE documentos RENAME TO documentos_old;`, { transaction: t });
      await qi.sequelize.query(`
        CREATE TABLE documentos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo TEXT NOT NULL,
          token TEXT UNIQUE,
          permissionario_id INTEGER,
          evento_id INTEGER,
          pdf_url TEXT,
          pdf_public_url TEXT,
          assinafy_id TEXT,
          status TEXT DEFAULT 'gerado',
          assinatura_url TEXT,
          signed_pdf_public_url TEXT,
          signed_at TEXT,
          signer TEXT,
          created_at TEXT
        );
      `, { transaction: t });
      await qi.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documentos_token ON documentos(token);`, { transaction: t });
      await qi.sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo);`, { transaction: t });
      await qi.sequelize.query(`
        INSERT OR REPLACE INTO documentos (
          id, tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url,
          assinafy_id, status, assinatura_url, signed_pdf_public_url, signed_at, signer, created_at
        )
        SELECT
          id, tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url,
          assinafy_id, status, assinatura_url, signed_pdf_public_url, signed_at, signer, created_at
        FROM documentos_old
        ORDER BY id;
      `, { transaction: t });
      await qi.sequelize.query(`DROP TABLE documentos_old;`, { transaction: t });
    });
  }
};
