const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sqlite3Real = require('sqlite3').verbose();

// Verify dashboard-stats counts Emitido/Reemitido statuses

test('dashboard-stats includes Emitido/Reemitido', async () => {
  const db = new sqlite3Real.Database(':memory:');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT);`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, valor REAL, status TEXT, sem_juros INTEGER DEFAULT 0);`);
  await run(`INSERT INTO permissionarios (id, nome_empresa) VALUES (1, 'Perm');`);

  const today = new Date();
  const future = new Date(today.getTime() + 86400000).toISOString().slice(0,10);
  const past = new Date(today.getTime() - 86400000).toISOString().slice(0,10);

  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, valor, status) VALUES (1,1,?,100,'Emitido')`, [future]);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, valor, status) VALUES (2,1,?,200,'Reemitido')`, [past]);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, valor, status) VALUES (3,1,?,300,'Pago')`, [future]);

  const sqlite3Path = require.resolve('sqlite3');
  delete require.cache[sqlite3Path];
  const sqlite3Mock = { verbose: () => ({ Database: function(){ return db; } }) };
  require.cache[sqlite3Path] = { exports: sqlite3Mock };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const userRoutes = require('../src/api/userRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/user', userRoutes);

  const request = supertest(app);
  const res = await request.get('/api/user/dashboard-stats').expect(200);
  assert.equal(res.body.darsPendentes, 1);
  assert.equal(res.body.darsVencidos, 1);
  assert.equal(res.body.valorTotalDevido, '300.00');

  db.close();
  delete require.cache[sqlite3Path];
  delete require.cache[authPath];
  delete require.cache[require.resolve('../src/api/userRoutes')];
});
