// tests/adminRelatorioDevedores.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');

// Evita impressão de token em páginas adicionais
const originalOn = PDFDocument.prototype.on;
PDFDocument.prototype.on = function(event, handler) {
  if (event === 'pageAdded') return this;
  return originalOn.call(this, event, handler);
};

function binaryParser(res, callback) {
  const data = [];
  res.on('data', chunk => data.push(chunk));
  res.on('end', () => {
    callback(null, Buffer.concat(data));
  });
}

test('relatorio devedores gera PDF com multiplas paginas', async () => {
  const dbPath = path.resolve(__dirname, 'test-relatorio-devedores.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  delete require.cache[require.resolve('../src/database/db')];
  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, tipo TEXT, valor_aluguel REAL)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, valor REAL, status TEXT, sem_juros INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT)`);

  for (let i = 1; i <= 40; i++) {
    const cnpj = String(i).padStart(14, '0');
    await run(
      `INSERT INTO permissionarios (id, nome_empresa, cnpj, tipo, valor_aluguel) VALUES (?,?,?,?,100)`,
      [i, `Perm ${i}`, cnpj, 'Normal']
    );
    await run(
      `INSERT INTO dars (id, permissionario_id, data_vencimento, valor, status) VALUES (?,?,?,?,?)`,
      [i, i, '2020-01-01', i, 'Emitido']
    );
  }

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
  assert.ok(parsed.numpages > 1);
  assert.match(parsed.text, /Perm 40Normal/);
  assert.match(parsed.text, /Perm 1Normal/);
});
