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

test('relatorio de dars inclui guias emitidas mesmo sem emitido_por_id ou permissionario', async () => {
  const dbPath = path.resolve(__dirname, 'test-relatorio-dars.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  delete require.cache[require.resolve('../src/database/db')];
  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, tipo TEXT, valor_aluguel REAL)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER,
 ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, linha_digitavel TEXT, data_emissao TEXT,
 emitido_por_id INTEGER)`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT UNIQUE)`);
  await run(`CREATE TABLE DARs_Eventos (id_dar INTEGER, id_evento INTEGER)`);
  await run(`CREATE TABLE Eventos (id INTEGER PRIMARY KEY, id_cliente INTEGER)`);
  await run(`CREATE TABLE Clientes_Eventos (id INTEGER PRIMARY KEY, nome_razao_social TEXT, tipo_cliente TEXT, documento TEXT)`);

  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj, tipo, valor_aluguel) VALUES (1, 'Perm', '12345678000199', 'Normal', 100)`);
  await run(`INSERT INTO Clientes_Eventos (id, nome_razao_social, tipo_cliente, documento) VALUES (1,'Cliente X','Normal','999')`);
  await run(`INSERT INTO Eventos (id, id_cliente) VALUES (1,1)`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status, numero_documento, pdf_url, data_emissao, emitido_por_id) VALUES (10,1,'2025-12-31',12,2025,100,'Emitido','DOC123','PDF','2025-08-15',1)`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status, numero_documento, pdf_url, data_emissao, emitido_por_id) VALUES (12,NULL,'2025-12-31',12,2025,200,'Emitido','DOC_EVENTO','PDF','2025-08-16',NULL)`);
  await run(`INSERT INTO DARs_Eventos (id_dar, id_evento) VALUES (12,1)`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status, numero_documento) VALUES (11,1,'2025-12-31',12,2025,100,'Novo','DOCNOVO')`);

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN', imprimirTokenEmPdf: async pdf => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { role: 'SUPER_ADMIN' }; next(); } };

  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  delete require.cache[require.resolve('../src/api/adminRoutes')];
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
  assert.match(parsed.text, /DOC123/);
  assert.match(parsed.text, /DOC_EVENTO/);
  assert.ok(!/DOCNOVO/.test(parsed.text));
});

test('retorna 204 quando nao existem dars emitidas', async () => {
  const dbPath = path.resolve(__dirname, 'test-relatorio-dars-empty.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  delete require.cache[require.resolve('../src/database/db')];
  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, tipo TEXT, valor_aluguel REAL)`);

  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER,
 ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, linha_digitavel TEXT, data_emissao TEXT,
 emitido_por_id INTEGER)`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT UNIQUE)`);
  await run(`CREATE TABLE DARs_Eventos (id_dar INTEGER, id_evento INTEGER)`);
  await run(`CREATE TABLE Eventos (id INTEGER PRIMARY KEY, id_cliente INTEGER)`);
  await run(`CREATE TABLE Clientes_Eventos (id INTEGER PRIMARY KEY, nome_razao_social TEXT, tipo_cliente TEXT, documento TEXT)`);

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN', imprimirTokenEmPdf: async pdf => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { role: 'SUPER_ADMIN' }; next(); } };

  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  delete require.cache[require.resolve('../src/api/adminRoutes')];
  const adminRoutes = require('../src/api/adminRoutes');

  const app = express();
  app.use('/', adminRoutes);

  await supertest(app).get('/relatorios/dars').expect(204);
});
