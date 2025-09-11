#!/usr/bin/env node
/**
 * Verifica tokens antigos sobrescritos na tabela `documentos_historico`.
 * Para cada token, consulta a API Assinafy via `getDocumentStatus` e,
 * se o documento estiver assinado, atualiza o registro como `status='assinado'`.
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { getDocumentStatus } = require('./src/services/assinafyClient');

const DB_PATH = process.env.SQLITE_STORAGE || path.resolve(process.cwd(), './sistemacipt.db');

function openDb() {
  return new sqlite3.Database(DB_PATH);
}

const all = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const run = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err); else resolve(this);
  });
});

async function main() {
  const db = openDb();
  try {
    const tokens = await all(
      db,
      `SELECT id, token, evento_id, status
         FROM documentos_historico
        WHERE token IS NOT NULL AND token <> ''
          AND (status IS NULL OR status <> 'assinado')`
    );

    for (const t of tokens) {
      try {
        const resp = await getDocumentStatus(t.token);
        const st = (resp?.status || resp?.data?.status || '').toLowerCase();
        if ([
          'certified',
          'certificated',
          'signed',
          'completed',
          'assinado',
        ].includes(st)) {
          await run(db, `UPDATE documentos_historico SET status='assinado' WHERE id=?`, [t.id]);
          console.log(`Token ${t.token} (evento ${t.evento_id}) marcado como assinado.`);
        } else {
          console.log(`Token ${t.token} (evento ${t.evento_id}) ainda com status '${st}'.`);
        }
      } catch (err) {
        console.error(`Falha ao consultar token ${t.token}:`, err.message);
      }
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

