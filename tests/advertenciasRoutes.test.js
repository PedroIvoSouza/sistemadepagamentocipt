const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

// Testa verificação de token de advertência
// Configura DB isolado

test('verifica advertência por token', async () => {
  const dbPath = path.resolve(__dirname, 'test-advertencias.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));

  await run(`CREATE TABLE Advertencias (
    id INTEGER PRIMARY KEY,
    evento_id INTEGER,
    cliente_id INTEGER,
    texto_fatos TEXT,
    clausulas_json TEXT,
    token TEXT,
    pdf_url TEXT,
    status TEXT,
    createdAt TEXT,
    updatedAt TEXT
  )`);

  await run(`INSERT INTO Advertencias (id, evento_id, cliente_id, token, pdf_url, status, createdAt, updatedAt) VALUES (1, 2, 3, 'TOK', '/doc.pdf', 'gerado', datetime('now'), datetime('now'))`);

  const advertenciasRoutes = require('../src/api/advertenciasRoutes');
  const app = express();
  app.use('/api/advertencias', advertenciasRoutes);

  const res = await supertest(app).get('/api/advertencias/token/TOK').expect(200);
  assert.equal(res.body.id, 1);
  assert.equal(res.body.evento_id, 2);
  assert.equal(res.body.token, 'TOK');

  await new Promise(resolve => db.close(resolve));
  delete require.cache[require.resolve('../src/database/db')];
});
