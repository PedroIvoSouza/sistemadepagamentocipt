const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sqlite3 = require('sqlite3').verbose();

// Integration test for /api/client/dashboard-stats with Emitido/Reemitido statuses

test('client dashboard-stats counts Emitido/Reemitido correctly', async () => {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run('CREATE TABLE Eventos (id INTEGER PRIMARY KEY, id_cliente INTEGER);');
  await run('CREATE TABLE dars (id INTEGER PRIMARY KEY, valor REAL, data_vencimento TEXT, status TEXT);');
  await run('CREATE TABLE DARs_Eventos (id INTEGER PRIMARY KEY, id_dar INTEGER, id_evento INTEGER);');

  await run('INSERT INTO Eventos (id, id_cliente) VALUES (1, 1);');

  const today = new Date();
  const future = new Date(today.getTime() + 86400000).toISOString().slice(0,10);
  const past = new Date(today.getTime() - 86400000).toISOString().slice(0,10);

  await run('INSERT INTO dars (id, valor, data_vencimento, status) VALUES (1,100,?,"Emitido")', [future]);
  await run('INSERT INTO dars (id, valor, data_vencimento, status) VALUES (2,200,?,"Reemitido")', [past]);
  await run('INSERT INTO dars (id, valor, data_vencimento, status) VALUES (3,300,?,"Pago")', [future]);

  await run('INSERT INTO DARs_Eventos (id_dar, id_evento) VALUES (1,1), (2,1), (3,1);');

  global.db = db;
  global.adminRouter = express.Router();
  global.publicRouter = express.Router();

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1, role: 'CLIENTE_EVENTO' }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  const { clientRoutes } = require('../src/api/clientRouter');
  const app = express();
  app.use(express.json());
  app.use('/api/client', clientRoutes);

  const request = supertest(app);
  const res = await request.get('/api/client/dashboard-stats').expect(200);

  assert.equal(res.body.darsPendentes, 1);
  assert.equal(res.body.darsVencidos, 1);
  assert.equal(res.body.darsPagos, 1);
  assert.equal(res.body.valorTotalDevido, 300);

  db.close();
  delete global.db;
  delete global.adminRouter;
  delete global.publicRouter;
  delete require.cache[authPath];
  delete require.cache[rolePath];
  delete require.cache[require.resolve('../src/api/clientRouter')];
});
