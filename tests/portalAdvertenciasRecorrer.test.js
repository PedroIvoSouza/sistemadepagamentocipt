const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

// Teste do recurso de advertência

function setupDb() {
  const dbPath = path.resolve(__dirname, 'test-adv-recorrer.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;
  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
  return { db, run, get, dbPath };
}

test('cliente recorre advertencia dentro do prazo', async () => {
  const { db, run, get } = setupDb();
  await run(`CREATE TABLE Clientes_Eventos (id INTEGER PRIMARY KEY, nome_razao_social TEXT, email TEXT)`);
  await run(`CREATE TABLE Eventos (id INTEGER PRIMARY KEY, id_cliente INTEGER)`);
  await run(`CREATE TABLE advertencias (id INTEGER PRIMARY KEY, evento_id INTEGER, prazo_recurso TEXT, status TEXT, recurso_texto TEXT, recurso_data TEXT)`);
  await run(`INSERT INTO Clientes_Eventos (id, nome_razao_social, email) VALUES (1, 'Cliente', 'c@c.com')`);
  await run(`INSERT INTO Eventos (id, id_cliente) VALUES (10, 1)`);
  await run(`INSERT INTO advertencias (id, evento_id, prazo_recurso, status) VALUES (5, 10, '2099-12-31', 'emitida')`);

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id:1, role:'CLIENTE_EVENTO' }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (req, _res, next) => next() };
  const nodemailerPath = require.resolve('nodemailer');
  require.cache[nodemailerPath] = { exports: { createTransport: () => ({ sendMail: async () => {} }) } };
  delete require.cache[require.resolve('../src/api/portalAdvertenciasRoutes')];
  const portalAdvertenciasRoutes = require('../src/api/portalAdvertenciasRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/portal/advertencias', portalAdvertenciasRoutes);

  await supertest(app)
    .post('/api/portal/advertencias/5/recorrer')
    .send({ texto: 'Quero recorrer' })
    .expect(200)
    .expect(res => assert.equal(res.body.ok, true));

  const row = await get(`SELECT status, recurso_texto FROM advertencias WHERE id = 5`);
  assert.equal(row.status, 'recurso_solicitado');
  assert.equal(row.recurso_texto, 'Quero recorrer');

  await new Promise(resolve => db.close(resolve));
  delete require.cache[require.resolve('../src/database/db')];
});

test('impede recurso fora do prazo', async () => {
  const { db, run } = setupDb();
  await run(`CREATE TABLE Clientes_Eventos (id INTEGER PRIMARY KEY, nome_razao_social TEXT, email TEXT)`);
  await run(`CREATE TABLE Eventos (id INTEGER PRIMARY KEY, id_cliente INTEGER)`);
  await run(`CREATE TABLE advertencias (id INTEGER PRIMARY KEY, evento_id INTEGER, prazo_recurso TEXT, status TEXT)`);
  await run(`INSERT INTO Clientes_Eventos (id, nome_razao_social, email) VALUES (1, 'Cliente', 'c@c.com')`);
  await run(`INSERT INTO Eventos (id, id_cliente) VALUES (10, 1)`);
  await run(`INSERT INTO advertencias (id, evento_id, prazo_recurso, status) VALUES (6, 10, '2000-01-01', 'emitida')`);

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id:1, role:'CLIENTE_EVENTO' }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (req, _res, next) => next() };
  const nodemailerPath = require.resolve('nodemailer');
  require.cache[nodemailerPath] = { exports: { createTransport: () => ({ sendMail: async () => {} }) } };
  delete require.cache[require.resolve('../src/api/portalAdvertenciasRoutes')];
  const portalAdvertenciasRoutes = require('../src/api/portalAdvertenciasRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/portal/advertencias', portalAdvertenciasRoutes);

  await supertest(app)
    .post('/api/portal/advertencias/6/recorrer')
    .send({ texto: 'Fora do prazo' })
    .expect(400);

  await new Promise(resolve => db.close(resolve));
  delete require.cache[require.resolve('../src/database/db')];
});
