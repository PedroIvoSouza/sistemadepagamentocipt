// tests/adminDarsComprovante.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

test('comprovante persiste data de pagamento encontrada', async () => {
  const dbPath = path.resolve(__dirname, 'test-admin-comprovante.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbModulePath];
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
    linha_digitavel TEXT,
    comprovante_token TEXT
  )`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, caminho TEXT, permissionario_id INTEGER, created_at TEXT)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, data_pagamento, mes_referencia, ano_referencia, valor, status, numero_documento, codigo_barras, linha_digitavel) VALUES (10, 1, '2024-01-10', NULL, 1, 2024, 100, 'Pago', 'NUM123', 'CB', 'LD')`);

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
    listarPagamentosPorDataArrecadacao: async (...args) => {
      rangeCalls.push(args);
      const [inicio] = args;
      if (inicio === '2024-01-15') {
        return [{ numeroGuia: 'NUM123', linhaDigitavel: 'LD', dataPagamento: '2024-01-15', valorPago: 100 }];
      }
      return [];
    }
  } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: {
    gerarTokenDocumento: async () => 'tok',
    imprimirTokenEmPdf: async (b64) => b64,
  } };

  const letterPath = path.resolve(__dirname, '../src/utils/pdfLetterhead.js');
  require.cache[letterPath] = { exports: { applyLetterhead: () => () => {}, abntMargins: () => ({}), cm: () => 0 } };

  const pdfkitPath = require.resolve('pdfkit');
  require.cache[pdfkitPath] = { exports: class {
    constructor() { this.page = { width: 595.28, height: 841.89 }; }
    on(event, cb) { if (event === 'data') this._data = cb; if (event === 'end') this._end = cb; }
    fontSize() { return this; }
    fillColor() { return this; }
    opacity() { return this; }
    text() { return this; }
    save() { return this; }
    restore() { return this; }
    rotate() { return this; }
    rect() { return { stroke: () => this }; }
    image() { return this; }
    end() { if (this._data) this._data(Buffer.from('PDF')); if (this._end) this._end(); }
  } };

  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/oe6upwAAAAASUVORK5CYII=', 'base64');
  const qrPath = require.resolve('qrcode');
  require.cache[qrPath] = { exports: { toBuffer: async () => png1x1 } };

  const bwipPath = require.resolve('bwip-js');
  require.cache[bwipPath] = { exports: { toBuffer: async () => png1x1 } };

  const adminPath = path.resolve(__dirname, '../src/api/adminDarsRoutes.js');
  const darServicePath = path.resolve(__dirname, '../src/services/darService.js');
  delete require.cache[adminPath];
  delete require.cache[darServicePath];

  const adminDarsRoutes = require('../src/api/adminDarsRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dars', adminDarsRoutes);

  await supertest(app).get('/api/admin/dars/10/comprovante').expect(200);

  assert.equal(directCalls.length, 1);
  assert.deepEqual(directCalls[0], ['NUM123', 'LD']);
  assert.ok(rangeCalls.length > 0);

  const row = await new Promise((res, rej) => db.get(`SELECT data_pagamento FROM dars WHERE id = 10`, [], (err, r) => err ? rej(err) : res(r)));
  assert.equal(row.data_pagamento, '2024-01-15');

  await new Promise((r) => db.close(r));

  delete require.cache[sefazPath];
  delete require.cache[tokenPath];
  delete require.cache[letterPath];
  delete require.cache[pdfkitPath];
  delete require.cache[qrPath];
  delete require.cache[bwipPath];
  delete require.cache[dbModulePath];
  delete require.cache[adminPath];
  delete require.cache[darServicePath];
});

test('comprovante busca pagamentos anteriores ao vencimento', async () => {
  const dbPath = path.resolve(__dirname, 'test-admin-comprovante-back.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbModulePath];
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
    linha_digitavel TEXT,
    comprovante_token TEXT
  )`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, caminho TEXT, permissionario_id INTEGER, created_at TEXT)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, data_pagamento, mes_referencia, ano_referencia, valor, status, numero_documento, codigo_barras, linha_digitavel) VALUES (11, 1, '2024-01-10', NULL, 1, 2024, 100, 'Pago', 'NUM124', 'CB', 'LD')`);

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
    listarPagamentosPorDataArrecadacao: async (...args) => {
      rangeCalls.push(args);
      const [inicio] = args;
      if (inicio === '2024-01-08') {
        return [{ numeroGuia: 'NUM124', linhaDigitavel: 'LD', dataPagamento: '2024-01-08', valorPago: 100 }];
      }
      return [];
    }
  } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: {
    gerarTokenDocumento: async () => 'tok',
    imprimirTokenEmPdf: async (b64) => b64,
  } };

  const letterPath = path.resolve(__dirname, '../src/utils/pdfLetterhead.js');
  require.cache[letterPath] = { exports: { applyLetterhead: () => () => {}, abntMargins: () => ({}), cm: () => 0 } };

  const pdfkitPath = require.resolve('pdfkit');
  require.cache[pdfkitPath] = { exports: class {
    constructor() { this.page = { width: 595.28, height: 841.89 }; }
    on(event, cb) { if (event === 'data') this._data = cb; if (event === 'end') this._end = cb; }
    fontSize() { return this; }
    fillColor() { return this; }
    opacity() { return this; }
    text() { return this; }
    save() { return this; }
    restore() { return this; }
    rotate() { return this; }
    rect() { return { stroke: () => this }; }
    image() { return this; }
    end() { if (this._data) this._data(Buffer.from('PDF')); if (this._end) this._end(); }
  } };

  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/oe6upwAAAAASUVORK5CYII=', 'base64');
  const qrPath = require.resolve('qrcode');
  require.cache[qrPath] = { exports: { toBuffer: async () => png1x1 } };

  const bwipPath = require.resolve('bwip-js');
  require.cache[bwipPath] = { exports: { toBuffer: async () => png1x1 } };

  const adminPath = path.resolve(__dirname, '../src/api/adminDarsRoutes.js');
  const darServicePath = path.resolve(__dirname, '../src/services/darService.js');
  delete require.cache[adminPath];
  delete require.cache[darServicePath];
  const adminDarsRoutes = require('../src/api/adminDarsRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dars', adminDarsRoutes);

  await supertest(app).get('/api/admin/dars/11/comprovante').expect(200);

  assert.equal(directCalls.length, 1);
  assert.ok(rangeCalls.some(([inicio]) => inicio === '2024-01-08'));

  const row = await new Promise((res, rej) => db.get(`SELECT data_pagamento FROM dars WHERE id = 11`, [], (err, r) => err ? rej(err) : res(r)));
  assert.equal(row.data_pagamento, '2024-01-08');

  await new Promise((r) => db.close(r));


  delete require.cache[sefazPath];
  delete require.cache[tokenPath];
  delete require.cache[letterPath];
  delete require.cache[pdfkitPath];
  delete require.cache[qrPath];
  delete require.cache[bwipPath];
  delete require.cache[dbModulePath];
  delete require.cache[adminPath];
  delete require.cache[darServicePath];

});

test('comprovante reutiliza PDF existente quando token e arquivo presentes', async () => {
  const dbPath = path.resolve(__dirname, 'test-admin-comprovante-existente.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbModulePath];
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
    linha_digitavel TEXT,
    comprovante_token TEXT
  )`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, caminho TEXT, permissionario_id INTEGER, created_at TEXT)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);

  const dir = path.resolve(__dirname, '../public/documentos');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'comp_existente.pdf');
  fs.writeFileSync(filePath, 'PDF');

  await run(`INSERT INTO documentos (token, caminho, permissionario_id) VALUES ('tok-existing', ?, 1)`, [filePath]);
  await run(`INSERT INTO dars (id, permissionario_id, numero_documento, codigo_barras, linha_digitavel, comprovante_token, status) VALUES (12, 1, 'NUM125', 'CB', 'LD', 'tok-existing', 'Pago')`);

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
  }};

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'tok', imprimirTokenEmPdf: async (b64) => b64 } };
  const letterPath = path.resolve(__dirname, '../src/utils/pdfLetterhead.js');
  require.cache[letterPath] = { exports: { applyLetterhead: () => () => {}, abntMargins: () => ({}), cm: () => 0 } };
  const pdfkitPath = require.resolve('pdfkit');
  require.cache[pdfkitPath] = { exports: class { constructor() { this.page = { width: 0, height: 0 }; } on(){} end(){} } };
  const qrPath = require.resolve('qrcode');
  require.cache[qrPath] = { exports: { toBuffer: async () => Buffer.from('') } };
  const bwipPath = require.resolve('bwip-js');
  require.cache[bwipPath] = { exports: { toBuffer: async () => Buffer.from('') } };

  const adminPath = path.resolve(__dirname, '../src/api/adminDarsRoutes.js');
  const darServicePath = path.resolve(__dirname, '../src/services/darService.js');
  delete require.cache[adminPath];
  delete require.cache[darServicePath];

  const adminDarsRoutes = require('../src/api/adminDarsRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dars', adminDarsRoutes);

  const resp = await supertest(app).get('/api/admin/dars/12/comprovante').expect(200);
  assert.equal(resp.headers['x-document-token'], 'tok-existing');
  assert.equal(resp.body.toString(), 'PDF');
  assert.equal(directCalls.length, 0);
  assert.equal(rangeCalls.length, 0);

  await new Promise((r) => db.close(r));

  delete require.cache[sefazPath];
  delete require.cache[tokenPath];
  delete require.cache[letterPath];
  delete require.cache[pdfkitPath];
  delete require.cache[qrPath];
  delete require.cache[bwipPath];
  delete require.cache[dbModulePath];
  delete require.cache[adminPath];
  delete require.cache[darServicePath];
});
