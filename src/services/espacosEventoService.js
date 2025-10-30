const db = require('../database/db');
const {
  normalizarEspacoNome,
  setEspacosTabelaOverrides,
} = require('./eventoValorService');

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });

let cachePromise = null;
let cache = [];

function sanitizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeSlug(slug, nome) {
  const base = String(slug || nome || '')
    .normalize('NFD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
  return base || `espaco-${Date.now()}`;
}

function mapRow(row) {
  const valores = {
    valor_diaria_1: sanitizeNumber(row.valor_diaria_1),
    valor_diaria_2: sanitizeNumber(row.valor_diaria_2),
    valor_diaria_3: sanitizeNumber(row.valor_diaria_3),
    valor_diaria_adicional: sanitizeNumber(row.valor_diaria_adicional),
  };
  const tabelaKey = normalizarEspacoNome(row.slug || row.nome);
  return {
    id: row.id,
    nome: row.nome,
    slug: row.slug,
    capacidade: sanitizeNumber(row.capacidade),
    area_m2: sanitizeNumber(row.area_m2),
    ...valores,
    ativo: Number(row.ativo) !== 0,
    criado_em: row.criado_em,
    atualizado_em: row.atualizado_em,
    tabela_key: tabelaKey,
  };
}

async function ensureSchema() {
  await runAsync(
    `CREATE TABLE IF NOT EXISTS espacos_evento (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      capacidade INTEGER NOT NULL DEFAULT 0,
      area_m2 REAL NOT NULL DEFAULT 0,
      valor_diaria_1 REAL NOT NULL DEFAULT 0,
      valor_diaria_2 REAL NOT NULL DEFAULT 0,
      valor_diaria_3 REAL NOT NULL DEFAULT 0,
      valor_diaria_adicional REAL NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT DEFAULT (datetime('now')),
      atualizado_em TEXT DEFAULT (datetime('now'))
    )`
  );

  const cols = await allAsync(`PRAGMA table_info('espacos_evento')`);
  const have = new Set(cols.map((c) => c.name));
  const maybeAdd = async (name, ddl) => {
    if (!have.has(name)) {
      await runAsync(`ALTER TABLE espacos_evento ADD COLUMN ${ddl}`);
    }
  };

  await maybeAdd('slug', "slug TEXT NOT NULL UNIQUE");
  await maybeAdd('capacidade', 'capacidade INTEGER NOT NULL DEFAULT 0');
  await maybeAdd('area_m2', 'area_m2 REAL NOT NULL DEFAULT 0');
  await maybeAdd('valor_diaria_1', 'valor_diaria_1 REAL NOT NULL DEFAULT 0');
  await maybeAdd('valor_diaria_2', 'valor_diaria_2 REAL NOT NULL DEFAULT 0');
  await maybeAdd('valor_diaria_3', 'valor_diaria_3 REAL NOT NULL DEFAULT 0');
  await maybeAdd('valor_diaria_adicional', 'valor_diaria_adicional REAL NOT NULL DEFAULT 0');
  await maybeAdd('ativo', 'ativo INTEGER NOT NULL DEFAULT 1');
  await maybeAdd('criado_em', "criado_em TEXT DEFAULT (datetime('now'))");
  await maybeAdd('atualizado_em', "atualizado_em TEXT DEFAULT (datetime('now'))");
}

async function loadCache() {
  await ensureSchema();
  const rows = await allAsync(`SELECT * FROM espacos_evento ORDER BY nome ASC`);
  cache = rows.map(mapRow);

  const ativos = cache.filter((c) => c.ativo);
  setEspacosTabelaOverrides(
    ativos.map((row) => ({
      tabelaKey: row.tabela_key,
      nome: row.nome,
      slug: row.slug,
      label: row.nome,
      capacidade: row.capacidade,
      area_m2: row.area_m2,
      valores: [
        row.valor_diaria_1,
        row.valor_diaria_2,
        row.valor_diaria_3,
        row.valor_diaria_adicional,
      ],
    }))
  );

  return cache;
}

async function refreshCache() {
  cachePromise = loadCache().catch((err) => {
    cachePromise = null;
    console.error('[espacosEventoService] Falha ao recarregar cache:', err?.message || err);
    throw err;
  });
  return cachePromise;
}

async function ensureCache() {
  if (!cachePromise) {
    await refreshCache();
  }
  return cachePromise;
}

async function listarEspacos({ incluirInativos = true } = {}) {
  await ensureCache();
  return incluirInativos ? [...cache] : cache.filter((c) => c.ativo);
}

async function criarEspaco(payload = {}) {
  const nome = String(payload.nome || '').trim();
  if (!nome) {
    const err = new Error('Informe o nome do espaço.');
    err.status = 400;
    throw err;
  }

  const slug = sanitizeSlug(payload.slug, nome);
  const capacidade = sanitizeNumber(payload.capacidade);
  const area = sanitizeNumber(payload.area_m2);
  const valores = [
    sanitizeNumber(payload.valor_diaria_1),
    sanitizeNumber(payload.valor_diaria_2),
    sanitizeNumber(payload.valor_diaria_3),
    sanitizeNumber(payload.valor_diaria_adicional),
  ];
  const ativo = payload.ativo === false ? 0 : 1;

  await ensureSchema();
  try {
    await runAsync(
      `INSERT INTO espacos_evento (
        nome, slug, capacidade, area_m2, valor_diaria_1, valor_diaria_2,
        valor_diaria_3, valor_diaria_adicional, ativo, criado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [nome, slug, capacidade, area, ...valores, ativo]
    );
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err?.message || '')) {
      const error = new Error('Já existe um espaço com este nome ou identificador.');
      error.status = 409;
      throw error;
    }
    throw err;
  }

  await refreshCache();
  return cache.find((c) => c.slug === slug) || null;
}

async function atualizarEspaco(id, payload = {}) {
  const row = await getAsync(`SELECT * FROM espacos_evento WHERE id = ?`, [id]);
  if (!row) {
    const err = new Error('Espaço não encontrado.');
    err.status = 404;
    throw err;
  }

  const nome = String(payload.nome ?? row.nome).trim();
  if (!nome) {
    const err = new Error('Informe o nome do espaço.');
    err.status = 400;
    throw err;
  }

  const slug = sanitizeSlug(payload.slug ?? row.slug, nome);
  const capacidade = sanitizeNumber(payload.capacidade ?? row.capacidade);
  const area = sanitizeNumber(payload.area_m2 ?? row.area_m2);
  const valores = [
    sanitizeNumber(payload.valor_diaria_1 ?? row.valor_diaria_1),
    sanitizeNumber(payload.valor_diaria_2 ?? row.valor_diaria_2),
    sanitizeNumber(payload.valor_diaria_3 ?? row.valor_diaria_3),
    sanitizeNumber(payload.valor_diaria_adicional ?? row.valor_diaria_adicional),
  ];
  const ativo = payload.ativo === undefined ? Number(row.ativo) : (payload.ativo ? 1 : 0);

  await ensureSchema();
  try {
    await runAsync(
      `UPDATE espacos_evento
         SET nome = ?,
             slug = ?,
             capacidade = ?,
             area_m2 = ?,
             valor_diaria_1 = ?,
             valor_diaria_2 = ?,
             valor_diaria_3 = ?,
             valor_diaria_adicional = ?,
             ativo = ?,
             atualizado_em = datetime('now')
       WHERE id = ?`,
      [nome, slug, capacidade, area, ...valores, ativo, id]
    );
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err?.message || '')) {
      const error = new Error('Já existe um espaço com este nome ou identificador.');
      error.status = 409;
      throw error;
    }
    throw err;
  }

  await refreshCache();
  return cache.find((c) => c.id === id) || null;
}

async function definirStatusEspaco(id, ativo = true) {
  await ensureSchema();
  await runAsync(
    `UPDATE espacos_evento
        SET ativo = ?,
            atualizado_em = datetime('now')
      WHERE id = ?`,
    [ativo ? 1 : 0, id]
  );
  await refreshCache();
  return cache.find((c) => c.id === id) || null;
}

refreshCache().catch(() => {});

module.exports = {
  ensureSchema,
  refreshCache,
  listarEspacos,
  criarEspaco,
  atualizarEspaco,
  definirStatusEspaco,
};
