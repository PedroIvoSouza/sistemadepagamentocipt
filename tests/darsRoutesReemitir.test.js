// tests/darsRoutesReemitir.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

test('reemitir DAR vencido atualiza valor e vencimento', async () => {
  const dbPath = path.resolve(__dirname, 'test-reemitir.db');
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, numero_documento TEXT, telefone_cobranca TEXT)`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, mes_referencia INTEGER, ano_referencia INTEGER, valor REAL, status TEXT, numero_documento TEXT, pdf_url TEXT, linha_digitavel TEXT, codigo_barras TEXT, link_pdf TEXT, data_emissao TEXT)`);
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj) VALUES (1, 'Perm', '12345678000199')`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status, data_emissao) VALUES (10,1,'2024-01-01',1,2024,100,'Vencido','2000-01-01')`);

  process.env.COD_IBGE_MUNICIPIO = '2704302';
  process.env.RECEITA_CODIGO_PERMISSIONARIO = '12345';

  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => ({ numeroGuia: '123', pdfBase64: 'PDF', linhaDigitavel: '00190500954014481606906809350314337370000000100' }) } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN', imprimirTokenEmPdf: async pdf => pdf } };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const cobrancaPath = path.resolve(__dirname, '../src/services/cobrancaService.js');
  require.cache[cobrancaPath] = { exports: { calcularEncargosAtraso: async () => ({ valorAtualizado: 200, novaDataVencimento: '2030-12-31' }) } };

  const darsRoutes = require('../src/api/darsRoutes');

  const app = express();
  app.use(express.json());
  app.use('/', darsRoutes);

  const antes = await get(`SELECT valor, data_vencimento, status, data_emissao FROM dars WHERE id = 10`);

  await supertest(app).post('/10/emitir').expect(200);

  const row = await get(`SELECT valor, data_vencimento, status, data_emissao FROM dars WHERE id = 10`);
  assert.equal(row.valor, 200);
  assert.equal(row.data_vencimento, '2030-12-31');
  assert.equal(row.status, 'Reemitido');
  assert.notEqual(row.data_emissao, antes.data_emissao);
});

