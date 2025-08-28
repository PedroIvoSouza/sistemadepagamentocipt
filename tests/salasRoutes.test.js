const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'testsecret';
process.env.SQLITE_STORAGE = ':memory:';

const db = require('../src/database/db');

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

async function resetDb() {
  await new Promise((resolve, reject) => {
    db.exec(
      `DROP TABLE IF EXISTS reservas_salas;
       DROP TABLE IF EXISTS salas_reuniao;
       CREATE TABLE salas_reuniao (
         id INTEGER PRIMARY KEY,
         numero TEXT,
         capacidade INTEGER,
         status TEXT
       );
       INSERT INTO salas_reuniao (id, numero, capacidade, status)
         VALUES (1, 'Sala 1', 5, 'disponivel');
       CREATE TABLE reservas_salas (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         sala_id INTEGER,
         permissionario_id INTEGER,
         data TEXT,
         hora_inicio TEXT,
         hora_fim TEXT,
         participantes INTEGER,
         status TEXT,
         checkin TEXT
       );`,
      err => (err ? reject(err) : resolve())
    );
  });
}

function userToken(id = 1) {
  return jwt.sign({ id, role: 'USER' }, process.env.JWT_SECRET);
}

function adminToken(id = 999) {
  return jwt.sign({ id, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET);
}

beforeEach(resetDb);

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
  app.use('/api/salas', loadUserRoutes());
  return app;
}

function setupAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/salas', loadAdminRoutes());
  return app;
}

test('Reserva válida', async () => {
  const app = setupUserApp();
  const token = userToken();
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${token}`)
    .send({
      sala_id: 1,
      data: '2025-10-10',
      horario_inicio: '10:00',
      horario_fim: '11:00',
      qtd_pessoas: 3,
    })
    .expect(201)
    .then(res => {
      assert.ok(res.body.id);
    });
});

test('Falha por menos de 3 participantes', async () => {
  const app = setupUserApp();
  const token = userToken();
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${token}`)
    .send({
      sala_id: 1,
      data: '2025-10-10',
      horario_inicio: '10:00',
      horario_fim: '11:00',
      qtd_pessoas: 2,
    })
    .expect(400)
    .then(res => {
      assert.equal(res.body.error, 'Reserva requer pelo menos 3 pessoas.');
    });
});

test('Bloqueio de reservas em dias consecutivos', async () => {
  const app = setupUserApp();
  const token = userToken();
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${token}`)
    .send({
      sala_id: 1,
      data: '2025-10-10',
      horario_inicio: '10:00',
      horario_fim: '11:00',
      qtd_pessoas: 3,
    })
    .expect(201);
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${token}`)
    .send({
      sala_id: 1,
      data: '2025-10-11',
      horario_inicio: '10:00',
      horario_fim: '11:00',
      qtd_pessoas: 3,
    })
    .expect(400)
    .then(res => {
      assert.equal(res.body.error, 'Não é permitido reservar dias consecutivos.');
    });
});

test('Cancelamento com menos de 24h', async () => {
  const app = setupUserApp();
  const token = userToken();
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const data = now.toISOString().slice(0, 10);
  const inicio = now.toTimeString().slice(0, 5);
  const fim = new Date(now.getTime() + 60 * 60 * 1000).toTimeString().slice(0, 5);
  const result = await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, ?, ?, ?, 3, 'pendente', NULL)`,
    [data, inicio, fim]
  );
  await supertest(app)
    .delete(`/api/salas/reservas/${result.lastID}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(400)
    .then(res => {
      assert.equal(res.body.error, 'Cancelamento permitido apenas com 24h de antecedência.');
    });
});

test('Admin altera status', async () => {
  const app = setupAdminApp();
  const token = adminToken();
  const result = await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, '2025-10-10', '10:00', '11:00', 3, 'pendente', NULL)`
  );
  await supertest(app)
    .patch(`/api/admin/salas/reservas/${result.lastID}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'confirmada' })
    .expect(200)
    .then(res => {
      assert.equal(res.body.message, 'Status atualizado');
    });
});

test('Admin realiza check-in', async () => {
  const app = setupAdminApp();
  const token = adminToken();
  const result = await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, '2025-10-10', '10:00', '11:00', 3, 'pendente', NULL)`
  );
  await supertest(app)
    .post(`/api/admin/salas/reservas/${result.lastID}/checkin`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200)
    .then(res => {
      assert.equal(res.body.message, 'Check-in realizado');
    });
});
