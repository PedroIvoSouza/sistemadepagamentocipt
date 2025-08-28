const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

function loadUserRoutes() {
  try {
    return require('../src/api/salasRoutes');
  } catch (err) {
    throw new Error('salasRoutes module not found');
  }
}

function loadAdminRoutes() {
  try {
    return require('../src/api/adminSalasRoutes');
  } catch (err) {
    throw new Error('adminSalasRoutes module not found');
  }
}

function setupUserApp() {
  const app = express();
  app.use(express.json());
  app.use('/salas', loadUserRoutes());
  return app;
}

function setupAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/salas', loadAdminRoutes());
  return app;
}

test('Reserva válida', async () => {
  const app = setupUserApp();
  await supertest(app)
    .post('/salas/reservas')
    .send({ salaId: 1, data: '2025-10-10', participantes: ['a', 'b', 'c'] })
    .expect(201)
    .then(res => {
      assert.equal(res.body.message, 'Reserva criada com sucesso');
    });
});

test('Falha por exceder capacidade ou menos de 3 participantes', async t => {
  const app = setupUserApp();
  await supertest(app)
    .post('/salas/reservas')
    .send({ salaId: 1, data: '2025-10-10', participantes: ['a', 'b'] })
    .expect(400);
});

test('Bloqueio de reservas em dias consecutivos', async t => {
  const app = setupUserApp();
  await supertest(app)
    .post('/salas/reservas')
    .send({ salaId: 1, data: '2025-10-10', participantes: ['a', 'b', 'c'] })
    .expect(201);
  await supertest(app)
    .post('/salas/reservas')
    .send({ salaId: 1, data: '2025-10-11', participantes: ['a', 'b', 'c'] })
    .expect(409);
});

test('Cancelamento com menos de 24h', async t => {
  const app = setupUserApp();
  await supertest(app)
    .delete('/salas/reservas/1')
    .expect(400);
});

test('Admin altera status', async () => {
  const app = setupAdminApp();
  await supertest(app)
    .patch('/admin/salas/reservas/1/status')
    .send({ status: 'confirmada' })
    .expect(200)
    .then(res => {
      assert.equal(res.body.message, 'Status atualizado');
    });
});

test('Admin realiza check-in', async () => {
  const app = setupAdminApp();
  await supertest(app)
    .post('/admin/salas/reservas/1/checkin')
    .expect(200)
    .then(res => {
      assert.equal(res.body.message, 'Check-in realizado');
    });
});
