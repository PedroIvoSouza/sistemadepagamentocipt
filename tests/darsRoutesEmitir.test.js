// tests/darsRoutesEmitir.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

const { codigoBarrasParaLinhaDigitavel, linhaDigitavelParaCodigoBarras } = require('../src/utils/boleto');

test('codigo_barras atualizado a partir da linha digitavel', async () => {
  const dbPath = path.resolve(__dirname, 'test-dars.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, numero_documento TEXT, telefone_cobranca TEXT)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER, ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, linha_digitavel TEXT, codigo_barras TEXT, link_pdf TEXT)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status) VALUES (10, 1, '2025-12-31', 12, 2025, 100, 'Novo')`);

  const cbOrig = '21290001192110001210904475617405975870000002000';
  const ld = codigoBarrasParaLinhaDigitavel(cbOrig);
  const cb44 = linhaDigitavelParaCodigoBarras(ld);

  process.env.COD_IBGE_MUNICIPIO = '2704302';
  process.env.RECEITA_CODIGO_PERMISSIONARIO = '12345';

  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => ({ numeroGuia: '123', pdfBase64: 'PDFDATA', linhaDigitavel: ld }) } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN', imprimirTokenEmPdf: async pdf => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const cobrancaPath = path.resolve(__dirname, '../src/services/cobrancaService.js');
  require.cache[cobrancaPath] = { exports: { calcularEncargosAtraso: async dar => ({ valorAtualizado: dar.valor, novaDataVencimento: null }) } };

  const darsRoutes = require('../src/api/darsRoutes');

  const app = express();
  app.use(express.json());
  app.use('/', darsRoutes);

  await supertest(app).post('/10/emitir').expect(200);

  const row = await get(`SELECT codigo_barras, link_pdf FROM dars WHERE id = 10`);
  assert.equal(row.codigo_barras, cb44);
  assert.equal(row.link_pdf, 'PDFDATA');
});

