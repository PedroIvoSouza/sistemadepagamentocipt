// tests/adminDarsComprovante.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

test('comprovante uses barcode lookup and clamps date range', async () => {
  const dbPath = path.resolve(__dirname, 'test-admin-comprovante.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT)`);
  await run(`CREATE TABLE dars (
    id INTEGER PRIMARY KEY,
    permissionario_id INTEGER,
    data_vencimento TEXT,
    data_pagamento TEXT,
    mes_referencia INTEGER,
    ano_referencia INTEGER,
    valor REAL,
    status TEXT,
    numero_documento TEXT,
    pdf_url TEXT,
    codigo_barras TEXT,
    linha_digitavel TEXT
  )`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, data_pagamento, mes_referencia, ano_referencia, valor, status, numero_documento, codigo_barras, linha_digitavel) VALUES (10, 1, '2024-01-10', '2024-01-15', 1, 2024, 100, 'Pago', 'NUM123', 'CB', 'LD')`);

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (_req, _res, next) => { _req.user = { id: 1 }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  const directCalls = [];
  const rangeCalls = [];
  require.cache[sefazPath] = { exports: {
    emitirGuiaSefaz: async () => ({}),
    consultarPagamentoPorCodigoBarras: async (...args) => { directCalls.push(args); return null; },
    listarPagamentosPorDataArrecadacao: async (...args) => { rangeCalls.push(args); return []; }
  } };

  const adminDarsRoutes = require('../src/api/adminDarsRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dars', adminDarsRoutes);

  await supertest(app).get('/api/admin/dars/10/comprovante').expect(404);

  assert.equal(directCalls.length, 1);
  assert.deepEqual(directCalls[0], ['NUM123', 'LD']);
  assert.equal(rangeCalls.length, 1);
  const [inicio, fim] = rangeCalls[0];
  assert.equal(inicio, '2024-01-15');
  assert.equal(fim, '2024-01-15');
});
