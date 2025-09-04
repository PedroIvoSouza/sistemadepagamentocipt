const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sqlite3 = require('sqlite3').verbose();

// Integration tests for /api/admin/dashboard-stats with tipo filter

test('dashboard-stats respects tipo filter', async () => {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, tipo TEXT);`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, tipo_permissionario TEXT, valor REAL, data_vencimento TEXT, status TEXT, mes_referencia INTEGER, ano_referencia INTEGER);`);

  await run(`INSERT INTO permissionarios (id, nome_empresa) VALUES (1, 'Perm A');`);
  await run(`INSERT INTO dars (id, permissionario_id, tipo_permissionario, valor, data_vencimento, status, mes_referencia, ano_referencia) VALUES (1, 1, 'Permissionario', 100, '2030-01-01', 'Pendente', 1, 2030);`);
  await run(`INSERT INTO dars (id, permissionario_id, tipo_permissionario, valor, data_vencimento, status, mes_referencia, ano_referencia) VALUES (2, NULL, 'Evento', 200, '2030-02-01', 'Pendente', 2, 2030);`);

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  require.cache[dbModulePath] = { exports: db };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id:1 }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  const adminRoutes = require('../src/api/adminRoutes');
  const app = express();
  app.use('/api/admin', adminRoutes);

  const request = supertest(app);

  const resAll = await request.get('/api/admin/dashboard-stats').expect(200);
  assert.equal(resAll.body.darsPendentes, 2);
  assert.equal(resAll.body.resumoMensal.length, 2);

  const resPerm = await request.get('/api/admin/dashboard-stats?tipo=permissionarios').expect(200);
  assert.equal(resPerm.body.darsPendentes, 1);
  assert.equal(resPerm.body.resumoMensal.length, 1);
  assert.equal(resPerm.body.resumoMensal[0].mes, 1);

  const resEventos = await request.get('/api/admin/dashboard-stats?tipo=eventos').expect(200);
  assert.equal(resEventos.body.darsPendentes, 1);
  assert.equal(resEventos.body.resumoMensal.length, 1);
  assert.equal(resEventos.body.resumoMensal[0].mes, 2);

  db.close();
  delete require.cache[dbModulePath];
});
