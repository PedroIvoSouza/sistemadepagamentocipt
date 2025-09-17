const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');

function setupRouter(arg) {
  const options = typeof arg === 'function' ? { atualizarMock: arg } : (arg || {});
  const atualizarMock = options.atualizarMock || (async () => {});
  const adminAuthPath = path.resolve(__dirname, '../src/middleware/adminAuthMiddleware.js');
  require.cache[adminAuthPath] = { exports: (_req, _res, next) => next() };
  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => {} } };
  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => {}, imprimirTokenEmPdf: async () => {} } };
  const dbStub = options.dbStub || { stub: true };
  const dbPath = path.resolve(__dirname, '../src/database/db.js');
  require.cache[dbPath] = { exports: dbStub };
  const servicePath = path.resolve(__dirname, '../src/services/eventoDarService.js');
  require.cache[servicePath] = { exports: { criarEventoComDars: async () => {}, atualizarEventoComDars: atualizarMock } };
  const assinafyClientPath = path.resolve(__dirname, '../src/services/assinafyClient.js');
  require.cache[assinafyClientPath] = { exports: { getDocumentStatus: async () => ({}) } };
  const assinafyPath = path.resolve(__dirname, '../src/services/assinafyService.js');
  const ensureSignerMock = options.ensureSignerMock || (async () => ({ id: 'signer-mock', email: 'mock@example.com' }));
  const requestSignaturesMock = options.requestSignaturesMock || (async () => {});
  require.cache[assinafyPath] = {
    exports: {
      uploadDocumentFromFile: async () => ({}),
      ensureSigner: ensureSignerMock,
      requestSignatures: requestSignaturesMock,
      getDocument: async () => ({}),
      pickBestArtifactUrl: () => null,
      waitUntilPendingSignature: async () => {},
      waitUntilReadyForAssignment: async () => {},
      getSigningUrl: async () => null,
      onlyDigits: (value = '') => String(value).replace(/\D/g, ''),
    },
  };
  delete require.cache[require.resolve('../src/api/adminEventosRoutes.js')];
  const routes = require('../src/api/adminEventosRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/', routes);
  return { app, dbStub };
}

test('PUT /:id atualiza evento', async () => {
  let called = false;
  const atualizarMock = async (dbArg, id, data, helpers) => {
    called = true;
    assert.equal(id, '1');
    assert.deepEqual(data, { a: 1 });
    assert.ok(dbArg.stub);
    assert.ok(typeof helpers.emitirGuiaSefaz === 'function');
  };
  const { app } = setupRouter(atualizarMock);
  const res = await supertest(app).put('/1').send({ a: 1 }).expect(200);
  assert.equal(res.body.message, 'Evento atualizado com sucesso!');
  assert.ok(called);
});

test('PUT /:id retorna 404 quando serviço indica não encontrado', async () => {
  const atualizarMock = async () => {
    const err = new Error('Evento não encontrado.');
    err.status = 404;
    throw err;
  };
  const { app } = setupRouter(atualizarMock);
  const res = await supertest(app).put('/999').send({}).expect(404);
  assert.equal(res.body.error, 'Evento não encontrado.');
});

test('PATCH /:id/status atualiza status do evento', async () => {
  const { app, dbStub } = setupRouter(async () => {});
  let called = false;
  dbStub.run = (sql, params, cb) => {
    called = true;
    assert.match(sql, /UPDATE Eventos SET status = \? WHERE id = \?/);
    assert.deepEqual(params, ['Pago', '5']);
    cb.call({ lastID: 0, changes: 1 }, null);
  };
  const res = await supertest(app).patch('/5/status').send({ status: 'Pago' }).expect(200);
  assert.ok(res.body.ok);
  assert.ok(called);
});

test('PATCH /:id/status rejeita status inválido', async () => {
  const { app, dbStub } = setupRouter(async () => {});
  dbStub.run = () => { throw new Error('não deveria executar'); };
  const res = await supertest(app).patch('/1/status').send({ status: 'Foo' }).expect(400);
  assert.equal(res.body.error, 'Status inválido.');
});

test('PATCH /:id/status retorna 404 quando evento não existe', async () => {
  const { app, dbStub } = setupRouter(async () => {});
  dbStub.run = (sql, params, cb) => {
    cb.call({ lastID: 0, changes: 0 }, null);
  };
  const res = await supertest(app).patch('/2/status').send({ status: 'Pago' }).expect(404);
  assert.equal(res.body.error, 'Evento não encontrado.');
});

test('POST /:id/termo/reativar-assinatura usa e-mail atualizado do signatário', async () => {
  const calls = [];
  const ensureSignerMock = async (payload) => {
    calls.push({ step: 'ensure', payload });
    return { id: 'signer-77', email: payload.email, telephone: payload.phone };
  };
  const requestSignaturesMock = async (docId, signerIds, options) => {
    calls.push({ step: 'request', docId, signerIds, options });
  };
  const dbStub = {
    stub: true,
    get: (sql, params, cb) => {
      calls.push({ step: 'db:get', sql, params });
      if (/FROM documentos/.test(sql)) {
        return cb(null, { assinafy_id: 'doc-123' });
      }
      return cb(null, null);
    },
    run: (sql, params, cb) => {
      calls.push({ step: 'db:run', sql, params });
      cb.call({ lastID: 0, changes: 1 }, null);
    },
  };

  const { app } = setupRouter({ atualizarMock: async () => {}, ensureSignerMock, requestSignaturesMock, dbStub });

  const res = await supertest(app)
    .post('/10/termo/reativar-assinatura')
    .send({
      signerName: 'Novo Contato',
      signerEmail: 'novo@example.com',
      signerCpf: '12345678900',
      signerPhone: '11988887777',
    })
    .expect(200);

  assert.deepEqual(res.body, { ok: true, message: 'Solicitação de assinatura reenviada com sucesso.' });

  const ensureCallIndex = calls.findIndex((c) => c.step === 'ensure');
  const requestCallIndex = calls.findIndex((c) => c.step === 'request');
  assert.ok(ensureCallIndex >= 0);
  assert.ok(requestCallIndex > ensureCallIndex);
  assert.deepEqual(calls[ensureCallIndex].payload, {
    full_name: 'Novo Contato',
    email: 'novo@example.com',
    government_id: '12345678900',
    phone: '+5511988887777',
  });
  assert.deepEqual(calls[requestCallIndex], {
    step: 'request',
    docId: 'doc-123',
    signerIds: ['signer-77'],
    options: { message: undefined, expires_at: undefined },
  });
  assert.ok(calls.some((c) => c.step === 'db:run'));
});
