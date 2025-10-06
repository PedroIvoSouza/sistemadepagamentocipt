// src/utils/sqliteFixes.js
const patchedConnections = new WeakMap();

function defaultAllFactory(db) {
  return (sql, params = [], ctx = 'sqlite/all') =>
    new Promise((resolve, reject) => {
      console.log('[sqliteFixes][ALL]', ctx, '\n ', sql, '\n ', 'params:', params);
      db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('[sqliteFixes][ALL][ERRO]', ctx, err.message);
          return reject(err);
        }
        resolve(rows);
      });
    });
}

function defaultRunFactory(db) {
  return (sql, params = [], ctx = 'sqlite/run') =>
    new Promise((resolve, reject) => {
      console.log('[sqliteFixes][RUN]', ctx, '\n ', sql, '\n ', 'params:', params);
      db.run(sql, params, function (err) {
        if (err) {
          console.error('[sqliteFixes][RUN][ERRO]', ctx, err.message);
          return reject(err);
        }
        console.log('[sqliteFixes][RUN][OK]', ctx, 'lastID:', this.lastID, 'changes:', this.changes);
        resolve(this);
      });
    });
}

function sanitizeTriggerName(name) {
  return String(name || '')
    .trim()
    .replace(/"/g, '""');
}

async function corrigirTriggersParcialmentePago(db, options = {}) {
  if (!db || typeof db !== 'object') return;

  const alreadyPatched = patchedConnections.get(db);
  if (alreadyPatched) {
    return;
  }

  const { all, run, ctxPrefix = 'sqlite/patch-parcial' } = options;
  const execAll = typeof all === 'function' ? all : defaultAllFactory(db);
  const execRun = typeof run === 'function' ? run : defaultRunFactory(db);

  let triggers;
  try {
    triggers = await execAll(
      `SELECT name, sql
         FROM sqlite_master
        WHERE type = 'trigger'
          AND sql LIKE '%Pago Parcialmente%'`,
      [],
      `${ctxPrefix}/listar`
    );
  } catch (err) {
    console.warn('[sqliteFixes] não foi possível listar triggers para correção:', err?.message || err);
    return;
  }

  if (!Array.isArray(triggers) || triggers.length === 0) {
    patchedConnections.set(db, true);
    return;
  }

  let appliedFix = false;

  for (const trigger of triggers) {
    const name = sanitizeTriggerName(trigger?.name);
    const sql = typeof trigger?.sql === 'string' ? trigger.sql : '';

    if (!name || !sql || !sql.toLowerCase().includes('pago parcialmente')) {
      continue;
    }

    const fixedSql = sql.replace(/Pago Parcialmente/gi, 'Parcialmente Pago');
    if (fixedSql === sql) {
      continue;
    }

    try {
      await execRun(`DROP TRIGGER IF EXISTS "${name}"`, [], `${ctxPrefix}/drop/${name}`);
      await execRun(fixedSql, [], `${ctxPrefix}/create/${name}`);
      appliedFix = true;
    } catch (err) {
      console.warn('[sqliteFixes] falha ao corrigir trigger', name, err?.message || err);
    }
  }

  if (appliedFix) {
    patchedConnections.set(db, true);
  }
}

module.exports = {
  corrigirTriggersParcialmentePago,
};

