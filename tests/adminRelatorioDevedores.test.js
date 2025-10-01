// tests/adminRelatorioDevedores.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');
const pdfParse = require('pdf-parse');

function binaryParser(res, callback) {
  res.setEncoding('binary');
  res.data = '';
  res.on('data', chunk => { res.data += chunk; });
  res.on('end', () => {
    callback(null, Buffer.from(res.data, 'binary'));
  });
}

test('relatorio devedores gera PDF contendo permissionario', async () => {
  const dbPath = path.resolve(__dirname, 'test-relatorio-devedores.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  delete require.cache[require.resolve('../src/database/db')];
  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, tipo TEXT, valor_aluguel REAL)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, valor REAL, status TEXT, sem_juros INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT)`);

  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj, tipo, valor_aluguel) VALUES (1, 'Perm', '12345678000199', 'Normal', 100)`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, valor, status) VALUES (1,1,'2020-01-01',50,'Emitido')`);

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN' } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { role: 'SUPER_ADMIN' }; next(); } };

  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  delete require.cache[require.resolve('../src/api/adminRoutes')];
  const adminRoutes = require('../src/api/adminRoutes');

  const app = express();
  app.use('/', adminRoutes);

  const res = await supertest(app)
    .get('/relatorios/devedores')
    .buffer()
    .parse(binaryParser)
    .expect(200);

  const parsed = await pdfParse(res.body);
  assert.match(parsed.text, /Perm/);
});
