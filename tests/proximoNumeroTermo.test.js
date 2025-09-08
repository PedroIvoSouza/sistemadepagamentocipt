const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sqlite3 = require('sqlite3').verbose();

const { fillNextNumeroTermo } = require('../public/js/proximoNumeroTermo.js');
const { getNextNumeroTermo } = require('../src/services/eventoDarService');

function createDb() {
  return new sqlite3.Database(':memory:');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

// ==== Teste do utilitário ====
test('getNextNumeroTermo retorna incremento correto', async () => {
  const db = createDb();
  await run(db, 'CREATE TABLE Eventos (id INTEGER PRIMARY KEY, numero_termo TEXT)');
  await run(db, "INSERT INTO Eventos (numero_termo) VALUES ('075/2025')");
  const next = await getNextNumeroTermo(db, 2025);
  assert.strictEqual(next, '076/2025');
  await new Promise(r => db.close(r));
});

// ==== Teste da rota ====
test('rota retorna próximo numeroTermo', async () => {
  const db = createDb();
  await run(db, 'CREATE TABLE Eventos (id INTEGER PRIMARY KEY, numero_termo TEXT)');
  await run(db, "INSERT INTO Eventos (numero_termo) VALUES ('001/2025')");

  const dbPath = path.resolve(__dirname, '../src/database/db.js');
  require.cache[dbPath] = { exports: db };
  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (_req, _res, next) => next() };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  delete require.cache[require.resolve('../src/api/adminTermoEventosRoutes.js')];
  const routes = require('../src/api/adminTermoEventosRoutes.js');
  const app = express();
  app.use('/', routes);

  const res = await supertest(app)
    .get('/termos/proximo-numero?ano=2025')
    .expect(200);

  assert.strictEqual(res.body.numeroTermo, '002/2025');
  await new Promise(r => db.close(r));
});

// ==== Teste do front-end util ====
test('fillNextNumeroTermo preenche campo automaticamente', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({ numeroTermo: '010/2025' }) };
  };
  const mask = { value: '' };
  await fillNextNumeroTermo(mask);
  assert.ok(called);
  assert.strictEqual(mask.value, '010/2025');
});
