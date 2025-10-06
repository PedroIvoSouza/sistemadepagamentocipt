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
  const roleMiddlewarePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[roleMiddlewarePath] = {
    exports: () => (_req, _res, next) => next(),
  };
  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => {} } };
  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  const gerarTokenDocumentoMock = options.gerarTokenDocumentoMock || (async () => {});
  require.cache[tokenPath] = {
    exports: {
      gerarTokenDocumento: gerarTokenDocumentoMock,
      imprimirTokenEmPdf: async () => {},
    },
  };
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
  const uploadDocumentMock = options.uploadDocumentMock || (async () => ({}));
  const waitUntilReadyForAssignmentMock = options.waitUntilReadyForAssignmentMock || (async () => {});
  require.cache[assinafyPath] = {
    exports: {
      uploadDocumentFromFile: uploadDocumentMock,
      ensureSigner: ensureSignerMock,
      requestSignatures: requestSignaturesMock,
      getDocument: async () => ({}),
      pickBestArtifactUrl: () => null,
      waitUntilPendingSignature: async () => {},
      waitUntilReadyForAssignment: waitUntilReadyForAssignmentMock,
      getSigningUrl: async () => null,
      onlyDigits: (value = '') => String(value).replace(/\D/g, ''),
    },
  };
  const termoServicePath = path.resolve(__dirname, '../src/services/termoEventoPdfkitService.js');
  const gerarTermoMock = options.gerarTermoMock || (async () => ({ filePath: '/tmp/mock.pdf', fileName: 'mock.pdf' }));
  require.cache[termoServicePath] = { exports: { gerarTermoEventoPdfkitEIndexar: gerarTermoMock } };
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

test('POST /:id/termo/enviar-assinatura salva CPF informado e não retorna erro', async () => {
  const calls = [];
  const dbStub = {
    stub: true,
    get: (sql, params, cb) => {
      calls.push({ step: 'db:get', sql, params });
      if (/FROM Eventos e/.test(sql)) {
        return cb(null, {
          nome_responsavel: 'Responsável',
          nome_razao_social: 'Empresa X',
          email: 'contato@example.com',
          telefone: '82991112233',
          documento_responsavel: '',
          documento: '12345678000100',
          nome_evento: 'Evento Teste',
          numero_termo: '123/2025',
          id_cliente: 77,
        });
      }
      return cb(null, null);
    },
    run: (sql, params, cb) => {
      calls.push({ step: 'db:run', sql, params });
      cb.call({ lastID: 0, changes: 1 }, null);
    },
  };

  const ensureSignerMock = async (payload) => {
    calls.push({ step: 'ensure', payload });
    return { id: 'signer-1', email: payload.email };
  };

  const requestSignaturesMock = async (docId, signerIds, options) => {
    calls.push({ step: 'request', docId, signerIds, options });
  };

  const gerarTermoMock = async (eventoId, opts) => {
    calls.push({ step: 'gerar', eventoId, opts });
    return { filePath: '/tmp/termo.pdf', fileName: 'termo.pdf' };
  };

  const uploadDocumentMock = async () => ({ id: 'assinafy-1' });

  const { app } = setupRouter({
    atualizarMock: async () => {},
    ensureSignerMock,
    requestSignaturesMock,
    dbStub,
    gerarTermoMock,
    uploadDocumentMock,
  });

  const res = await supertest(app)
    .post('/55/termo/enviar-assinatura')
    .send({
      signerName: 'Responsável',
      signerEmail: 'contato@example.com',
      signerCpf: '123.456.789-09',
      signerPhone: '(82) 99111-2233',
    })
    .expect(200);

  assert.deepEqual(res.body, {
    ok: true,
    message: 'Documento enviado com sucesso! O signatário receberá as instruções por e-mail.',
  });

  const cpfUpdate = calls.find(
    (c) =>
      c.step === 'db:run' &&
      /UPDATE Clientes_Eventos SET documento_responsavel = \? WHERE id = \?/.test(c.sql)
  );
  assert.ok(cpfUpdate, 'esperava atualização do documento_responsavel');
  assert.equal(cpfUpdate.params[0], '12345678909');
  assert.equal(String(cpfUpdate.params[1]), '77');

  const gerarCall = calls.find((c) => c.step === 'gerar');
  assert.ok(gerarCall, 'esperava chamada para geração do termo');
  assert.equal(gerarCall.opts.cpfResponsavel, '12345678909');

  const ensureCall = calls.find((c) => c.step === 'ensure');
  assert.ok(ensureCall, 'esperava chamada ensureSigner');
  assert.equal(ensureCall.payload.government_id, '12345678909');

  const requestCall = calls.find((c) => c.step === 'request');
  assert.ok(requestCall, 'esperava requestSignatures');
  assert.deepEqual(requestCall.signerIds, ['signer-1']);
});

test('POST /:eventoId/dars/:darId/baixa-manual reutiliza documento manual existente do evento', async () => {
  const fs = require('fs');
  const mkdirCalls = [];
  const writeCalls = [];
  const existsCalls = [];
  const unlinkCalls = [];
  const originalMkdir = fs.mkdirSync;
  const originalWrite = fs.writeFileSync;
  const originalExists = fs.existsSync;
  const originalUnlink = fs.unlinkSync;
  fs.mkdirSync = (...args) => {
    mkdirCalls.push(args);
  };
  fs.writeFileSync = (...args) => {
    writeCalls.push(args);
  };
  fs.existsSync = (...args) => {
    existsCalls.push(args);
    return false;
  };
  fs.unlinkSync = (...args) => {
    unlinkCalls.push(args);
  };

  let gerarTokenChamadas = 0;
  const gerarTokenDocumentoMock = async () => {
    gerarTokenChamadas += 1;
    return 'novo-token';
  };

  const dbStub = {
    stub: true,
    get: (sql, params, cb) => {
      if (/FROM DARs_Eventos/.test(sql)) {
        return cb(null, {
          dar_id: 10,
          status: 'Emitido',
          comprovante_token: null,
          data_pagamento: null,
        });
      }

      if (/FROM documentos\s+WHERE evento_id/.test(sql)) {
        return cb(null, { id: 33, token: 'token-existente', caminho: '/caminho/antigo.pdf' });
      }

      return cb(null, null);
    },
    run: (sql, params, cb) => {
      if (/UPDATE documentos/.test(sql)) {
        cb.call({ lastID: 0, changes: 1 }, null);
        return;
      }

      if (/UPDATE dars/.test(sql)) {
        cb.call({ lastID: 0, changes: 1 }, null);
        return;
      }

      throw new Error(`SQL inesperado: ${sql}`);
    },
  };

  const { app } = setupRouter({ dbStub, gerarTokenDocumentoMock });

  try {
    const response = await supertest(app)
      .post('/55/dars/10/baixa-manual')
      .field('dataPagamento', '2025-10-01')
      .attach('comprovante', Buffer.from('%PDF-1.4'), 'comprovante.pdf')
      .expect(200);

    assert.equal(response.body.token, 'token-existente');
    assert.equal(response.body.data_pagamento, '2025-10-01');
    assert.equal(gerarTokenChamadas, 0);
    assert.ok(mkdirCalls.length > 0);
    assert.ok(writeCalls.length > 0);
    assert.equal(existsCalls.length, 1);
    assert.equal(unlinkCalls.length, 0);
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.writeFileSync = originalWrite;
    fs.existsSync = originalExists;
    fs.unlinkSync = originalUnlink;
  }
});
