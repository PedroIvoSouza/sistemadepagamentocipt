const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');

function setupRouter(atualizarMock) {
  const adminAuthPath = path.resolve(__dirname, '../src/middleware/adminAuthMiddleware.js');
  require.cache[adminAuthPath] = { exports: (_req, _res, next) => next() };
  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = { exports: { emitirGuiaSefaz: async () => {} } };
  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => {}, imprimirTokenEmPdf: async () => {} } };
  const dbStub = { stub: true };
  const dbPath = path.resolve(__dirname, '../src/database/db.js');
  require.cache[dbPath] = { exports: dbStub };
  const servicePath = path.resolve(__dirname, '../src/services/eventoDarService.js');
  require.cache[servicePath] = { exports: { criarEventoComDars: async () => {}, atualizarEventoComDars: atualizarMock } };
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
