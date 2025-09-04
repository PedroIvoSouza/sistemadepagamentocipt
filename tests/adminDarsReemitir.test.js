// tests/adminDarsReemitir.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

test('reemitir DAR vencido atualiza valor e vencimento', async () => {
  const dbPath = path.resolve(__dirname, 'test-admin-reemit.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
  const get = (sql, params=[]) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, cpf TEXT, tipo TEXT)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER, ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, codigo_barras TEXT, link_pdf TEXT, data_emissao TEXT, emitido_por_id INTEGER)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status) VALUES (99, 1, '2024-01-01', 1, 2024, 100, 'Vencido')`);

  process.env.COD_IBGE_MUNICIPIO = '2704302';
  process.env.RECEITA_CODIGO_PERMISSIONARIO = '12345';

  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => ({ numeroGuia: '999', pdfBase64: 'PDF' }) } };

  const cobrancaPath = path.resolve(__dirname, '../src/services/cobrancaService.js');
  require.cache[cobrancaPath] = { exports: { calcularEncargosAtraso: async () => ({ valorAtualizado: 150, novaDataVencimento: '2030-01-31' }) } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'T', imprimirTokenEmPdf: async (pdf) => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (req, _res, next) => next() };

  const adminDarsRoutes = require('../src/api/adminDarsRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dars', adminDarsRoutes);

  await supertest(app).post('/api/admin/dars/99/reemitir').send({}).expect(200);

  const row = await get(`SELECT valor, data_vencimento, status, numero_documento, pdf_url FROM dars WHERE id = 99`);
  assert.equal(row.valor, 150);
  assert.equal(row.data_vencimento, '2030-01-31');
  assert.equal(row.status, 'Reemitido');
  assert.equal(row.numero_documento, '999');
  assert.equal(row.pdf_url, 'PDF');
});
