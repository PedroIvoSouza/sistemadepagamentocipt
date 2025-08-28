// tests/adminRelatorioDars.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');
const pdfParse = require('pdf-parse');

// Binary parser for supertest
function binaryParser(res, callback) {
  res.setEncoding('binary');
  res.data = '';
  res.on('data', chunk => { res.data += chunk; });
  res.on('end', () => {
    callback(null, Buffer.from(res.data, 'binary'));
  });
}

test('relatorio de dars inclui apenas guias emitidas por permissionarios', async () => {
  const dbPath = path.resolve(__dirname, 'test-relatorio-dars.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER, ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, linha_digitavel TEXT, data_emissao TEXT, emitido_por_id INTEGER)`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT UNIQUE)`);

  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status, numero_documento, pdf_url, data_emissao, emitido_por_id) VALUES (10,1,'2025-12-31',12,2025,100,'Emitido','DOC123','PDF','2025-08-15',1)`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status) VALUES (11,1,'2025-12-31',12,2025,100,'Novo')`);

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN', imprimirTokenEmPdf: async pdf => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { role: 'SUPER_ADMIN' }; next(); } };

  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  const adminRoutes = require('../src/api/adminRoutes');

  const app = express();
  app.use('/', adminRoutes);

  const res = await supertest(app)
    .get('/relatorios/dars')
    .buffer()
    .parse(binaryParser)
    .expect(200);

  const parsed = await pdfParse(res.body);
  assert.match(parsed.text, /Perm/);
  assert.match(parsed.text, /15\/08\/2025/);
  assert.match(parsed.text, /DOC123/);
  // Ensure only one emitted DAR is listed
  assert.ok(!/DOC123.*DOC123/.test(parsed.text));
});
