// tests/darsRoutesEmitirVencido.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

// Helper to setup DB and run queries
const setupDb = async (dbPath) => {
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;
  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, numero_documento TEXT, telefone_cobranca TEXT, tipo TEXT)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER, ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, linha_digitavel TEXT, codigo_barras TEXT, link_pdf TEXT, data_emissao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status) VALUES (20, 1, '2024-01-01', 1, 2024, 100, 'Vencido')`);
  return { db, run, get };
};

test('retorna darVencido sem emitir guia', async () => {
  const dbPath = path.resolve(__dirname, 'test-dars-vencido.db');
  const { get } = await setupDb(dbPath);

  // Stubs
  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => { throw new Error('should not emit'); } } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN', imprimirTokenEmPdf: async pdf => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const cobrancaPath = path.resolve(__dirname, '../src/services/cobrancaService.js');
  require.cache[cobrancaPath] = { exports: { calcularEncargosAtraso: async dar => ({ valorAtualizado: dar.valor + 10, novaDataVencimento: '2024-01-10' }) } };

  const darsRoutesPath = path.resolve(__dirname, '../src/api/darsRoutes.js');
  delete require.cache[darsRoutesPath];
  const darsRoutes = require(darsRoutesPath);

  const app = express();
  app.use(express.json());
  app.use('/', darsRoutes);

  const res = await supertest(app).post('/20/emitir').expect(200);
  assert.equal(res.body.darVencido, true);
  assert.equal(res.body.calculo.valorAtualizado, 110);

  const row = await get(`SELECT numero_documento, pdf_url FROM dars WHERE id = 20`);
  assert.equal(row.numero_documento, null);
  assert.equal(row.pdf_url, null);
});
