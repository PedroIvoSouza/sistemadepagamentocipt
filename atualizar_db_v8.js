// atualizar_db_v8.js
// Adiciona colunas necessárias para emissão/armazenamento de DAR:
// - dars.numero_documento (TEXT)
// - dars.pdf_url          (TEXT)
// (Opcional) adiciona permissionarios.numero_documento (TEXT), se quiser guardar último doc SEFAZ do permissionário.

const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_STORAGE || './sistemacipt.db';
const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function tableExists(table) {
  const row = await get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [table]
  );
  return !!row;
}

async function hasColumn(table, column) {
  const info = await all(`PRAGMA table_info(${table})`);
  return info.some((c) => c.name === column);
}

(async () => {
  console.log('=== Atualização do banco: adicionar colunas para emissão de DAR ===');
  console.log(`Usando DB: ${DB_PATH}`);

  // --- Tabela dars ---
  const darsExists = await tableExists('dars');
  if (!darsExists) {
    console.error('❌ Tabela "dars" não encontrada neste banco. Verifique o DB_PATH.');
  } else {
    // numero_documento
    const darsHasNumero = await hasColumn('dars', 'numero_documento');
    if (!darsHasNumero) {
      try {
        await run(`ALTER TABLE dars ADD COLUMN numero_documento TEXT`);
        console.log('✅ dars.numero_documento criado.');
      } catch (e) {
        if (String(e.message || '').includes('duplicate column name')) {
          console.log('ℹ️ dars.numero_documento já existia.');
        } else {
          console.error('❌ Erro ao criar dars.numero_documento:', e.message);
        }
      }
    } else {
      console.log('ℹ️ dars.numero_documento já existe.');
    }

    // pdf_url
    const darsHasPdf = await hasColumn('dars', 'pdf_url');
    if (!darsHasPdf) {
      try {
        await run(`ALTER TABLE dars ADD COLUMN pdf_url TEXT`);
        console.log('✅ dars.pdf_url criado.');
      } catch (e) {
        if (String(e.message || '').includes('duplicate column name')) {
          console.log('ℹ️ dars.pdf_url já existia.');
        } else {
          console.error('❌ Erro ao criar dars.pdf_url:', e.message);
        }
      }
    } else {
      console.log('ℹ️ dars.pdf_url já existe.');
    }
  }

  // --- (Opcional) Tabela permissionarios ---
  // só para armazenar o último doc emitido por permissionário, se for útil depois
  const permExists = await tableExists('permissionarios');
  if (!permExists) {
    console.warn('⚠️ Tabela "permissionarios" não encontrada (ok se seu schema usa outro nome).');
  } else {
    const permHasNumero = await hasColumn('permissionarios', 'numero_documento');
    if (!permHasNumero) {
      try {
        await run(`ALTER TABLE permissionarios ADD COLUMN numero_documento TEXT`);
        console.log('✅ permissionarios.numero_documento criado.');
      } catch (e) {
        if (String(e.message || '').includes('duplicate column name')) {
          console.log('ℹ️ permissionarios.numero_documento já existia.');
        } else {
          console.error('❌ Erro ao criar permissionarios.numero_documento:', e.message);
        }
      }
    } else {
      console.log('ℹ️ permissionarios.numero_documento já existe.');
    }
  }

  console.log('=== Atualização finalizada. ===');
  db.close();
})().catch((err) => {
  console.error('Falha geral na atualização:', err);
  try { db.close(); } catch {}
  process.exit(1);
});