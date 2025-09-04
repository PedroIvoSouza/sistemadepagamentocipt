const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');

function setup(fetchCnpjMock) {
  const adminAuthPath = path.resolve(__dirname, '../src/middleware/adminAuthMiddleware.js');
  const adminAuthOrig = require.cache[adminAuthPath];
  require.cache[adminAuthPath] = { exports: (_req, _res, next) => next() };
  const emailPath = path.resolve(__dirname, '../src/services/emailService.js');
  const emailOrig = require.cache[emailPath];
  require.cache[emailPath] = { exports: { enviarEmailDefinirSenha: async () => {} } };
  const cnpjPath = path.resolve(__dirname, '../src/services/cnpjLookupService.js');
  const cnpjOrig = require.cache[cnpjPath];
  require.cache[cnpjPath] = { exports: { fetchCnpjData: fetchCnpjMock } };
  const assinafyPath = path.resolve(__dirname, '../src/services/assinafyClient.js');
  const assinafyOrig = require.cache[assinafyPath];
  require.cache[assinafyPath] = { exports: { uploadPdf: async () => {} } };
  const termoPath = path.resolve(__dirname, '../src/services/termoEventoPdfkitService.js');
  const termoOrig = require.cache[termoPath];
  require.cache[termoPath] = { exports: { gerarTermoEventoPdfkitEIndexar: async () => {} } };

  const runCalls = [];
  const sqlite3Path = require.resolve('sqlite3');
  const sqlite3Orig = require.cache[sqlite3Path];
  require.cache[sqlite3Path] = {
    exports: {
      verbose: () => ({
        Database: class {
          run(sql, params, cb) { runCalls.push(params); cb && cb.call({ lastID: 1 }, null); }
          get() {}
          all() {}
        }
      })
    }
  };

  delete require.cache[require.resolve('../src/api/eventosClientesRoutes.js')];
  const routes = require('../src/api/eventosClientesRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/', routes.adminRoutes);

  // restore originals to avoid leaking to other tests
  require.cache[adminAuthPath] = adminAuthOrig;
  require.cache[emailPath] = emailOrig;
  require.cache[cnpjPath] = cnpjOrig;
  require.cache[sqlite3Path] = sqlite3Orig;
  require.cache[assinafyPath] = assinafyOrig;
  require.cache[termoPath] = termoOrig;

  return { app, runCalls };
}

test('preenche dados do CNPJ e permite sobrescrever', async () => {
  const { app, runCalls } = setup(async () => ({
    razao_social: 'API RS',
    nome_fantasia: 'API NF',
    logradouro: 'Rua API',
    bairro: 'Bairro API',
    cidade: 'Cidade API',
    uf: 'SP',
    cep: '12345678'
  }));

  const res = await supertest(app).post('/').send({
    tipo_pessoa: 'PJ',
    documento: '12.345.678/0001-00',
    email: 'a@a.com',
    tipo_cliente: 'Geral',
    logradouro: 'Rua Manual'
  }).expect(201);
  assert.match(res.body.message, /Cliente criado/);
  const params = runCalls[0];
  assert.equal(params[0], 'API RS');
  assert.equal(params[10], 'Rua Manual');
  assert.equal(params[9], '12345678');
  assert.equal(params[13], 'Bairro API');
  assert.equal(params[14], 'Cidade API');
  assert.equal(params[15], 'SP');
});

test('continua quando consulta CNPJ falha', async () => {
  const { app, runCalls } = setup(async () => { throw new Error('bad'); });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a); };
  const res = await supertest(app).post('/').send({
    nome_razao_social: 'Manual',
    tipo_pessoa: 'PJ',
    documento: '11.111.111/0001-00',
    email: 'b@b.com',
    tipo_cliente: 'Geral',
    cidade: 'Cidade Manual'
  }).expect(201);
  console.error = origError;
  assert.match(res.body.message, /Cliente criado/);
  assert.ok(errors.length > 0);
  const params = runCalls[0];
  assert.equal(params[0], 'Manual');
  assert.equal(params[14], 'Cidade Manual');
});
