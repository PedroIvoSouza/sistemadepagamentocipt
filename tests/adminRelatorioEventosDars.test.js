// tests/adminRelatorioEventosDars.test.js
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

test('relatorio de dars de eventos filtra por data', async () => {
  const dbPath = path.resolve(__dirname, 'test-relatorio-eventos-dars.db');
  try { fs.unlinkSync(dbPath); } catch {}
  const prevDb = process.env.SQLITE_STORAGE;
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));

  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, status TEXT, numero_documento TEXT, data_emissao TEXT, valor REAL);`);
  await run(`CREATE TABLE DARs_Eventos (id_dar INTEGER, id_evento INTEGER);`);
  await run(`CREATE TABLE Eventos (id INTEGER PRIMARY KEY, nome_evento TEXT, id_cliente INTEGER);`);
  await run(`CREATE TABLE Clientes_Eventos (id INTEGER PRIMARY KEY, nome_razao_social TEXT);`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT UNIQUE);`);

  await run(`INSERT INTO Clientes_Eventos (id, nome_razao_social) VALUES (1,'Cliente X');`);
  await run(`INSERT INTO Eventos (id, nome_evento, id_cliente) VALUES (1,'Evento Y',1);`);
  await run(`INSERT INTO dars (id, status, numero_documento, data_emissao, valor) VALUES (1,'Emitido','DAR123','2025-08-15',100);`);
  await run(`INSERT INTO DARs_Eventos (id_dar, id_evento) VALUES (1,1);`);
  await run(`INSERT INTO dars (id, status, numero_documento, data_emissao, valor) VALUES (2,'Emitido','DAR999','2025-09-10',50);`);
  await run(`INSERT INTO DARs_Eventos (id_dar, id_evento) VALUES (2,1);`);

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
    .get('/relatorios/eventos-dars?dataInicio=2025-08-01&dataFim=2025-08-31')
    .buffer()
    .parse(binaryParser)
    .expect(200);

  const parsed = await pdfParse(res.body);
  assert.match(parsed.text, /Evento Y/);
  assert.match(parsed.text, /Cliente X/);
  assert.match(parsed.text, /DAR123/);
  assert.ok(!/DAR999/.test(parsed.text));

  await supertest(app)
    .get('/relatorios/eventos-dars?dataInicio=2025-07-01&dataFim=2025-07-31')
    .expect(204);

  db.close();
  delete require.cache[require.resolve('../src/database/db')];
  process.env.SQLITE_STORAGE = prevDb;
});
