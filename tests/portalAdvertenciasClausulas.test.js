const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

test('portal retorna clausulas do termo', async () => {
  const dbPath = path.resolve(__dirname, 'test-adv-clausulas.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id:1, role:'CLIENTE_EVENTO' }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (req, _res, next) => next() };

  delete require.cache[require.resolve('../src/api/portalAdvertenciasRoutes')];
  const portalAdvertenciasRoutes = require('../src/api/portalAdvertenciasRoutes');
  const app = express();
  app.use('/api/portal/advertencias', portalAdvertenciasRoutes);

  const termoClausulas = require('../src/constants/termoClausulas');

  await supertest(app)
    .get('/api/portal/advertencias/clausulas')
    .expect(200)
    .expect(res => assert.deepEqual(res.body, termoClausulas));

  const db = require('../src/database/db');
  await new Promise(resolve => db.close(resolve));
  delete require.cache[require.resolve('../src/database/db')];
});
