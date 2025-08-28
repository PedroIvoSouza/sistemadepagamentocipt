const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const path = require('path');

process.env.JWT_SECRET = 'testsecret';
process.env.SQLITE_STORAGE = path.resolve(__dirname, 'salas.test.db');

const db = require('../src/database/db');

function resetDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DROP TABLE IF EXISTS reservas_salas');
      db.run('DROP TABLE IF EXISTS salas_reuniao');
      db.run(
        'CREATE TABLE salas_reuniao (id INTEGER PRIMARY KEY, numero TEXT, capacidade INTEGER, status TEXT)',
      );
      db.run(
        'CREATE TABLE reservas_salas (id INTEGER PRIMARY KEY, sala_id INTEGER, permissionario_id INTEGER, data TEXT, hora_inicio TEXT, hora_fim TEXT, participantes INTEGER, status TEXT, checkin TEXT)',
        err => {
          if (err) return reject(err);
          db.run(
            "INSERT INTO salas_reuniao (id, numero, capacidade, status) VALUES (1, 'Sala 1', 5, 'disponivel')",
            err2 => (err2 ? reject(err2) : resolve()),
          );
        },
      );
    });
  });
}

beforeEach(resetDb);

const userToken = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
const adminToken = jwt.sign({ id: 999, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET);


function loadUserRoutes() {
  return require('../src/api/salasRoutes');
}

function loadAdminRoutes() {
  return require('../src/api/adminSalasRoutes');
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

function insertReserva(data, inicio, fim, permissionario = 1) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
       VALUES (1, ?, ?, ?, ?, 3, 'pendente', NULL)`,
      [permissionario, data, inicio, fim],
      function (err) {
        if (err) reject(err); else resolve(this.lastID);
      },
    );
  });
}

test('Reserva válida', async () => {
  const app = setupUserApp();
  const token = userToken();
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${userToken}`)
    .send({
      sala_id: 1,
      data: '2025-10-10',
      horario_inicio: '09:00',
      horario_fim: '10:00',

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
    .set('Authorization', `Bearer ${userToken}`)
    .send({
      sala_id: 1,
      data: '2025-10-10',
      horario_inicio: '09:00',
      horario_fim: '10:00',

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
    .set('Authorization', `Bearer ${userToken}`)
    .send({
      sala_id: 1,
      data: '2025-10-10',
      horario_inicio: '09:00',
      horario_fim: '10:00',

      qtd_pessoas: 3,
    })
    .expect(201);
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${userToken}`)
    .send({
      sala_id: 1,
      data: '2025-10-11',
      horario_inicio: '09:00',
      horario_fim: '10:00',

      qtd_pessoas: 3,
    })
    .expect(400)
    .then(res => {

      assert.equal(res.body.error, 'Não é permitido reservar dias consecutivos.');
    });
});

test('Cancelamento com menos de 24h', async () => {
  const now = new Date();
  const data = now.toISOString().slice(0, 10);
  const inicio = new Date(now.getTime() + 60 * 60 * 1000)
    .toTimeString()
    .slice(0, 5);
  const fim = new Date(now.getTime() + 2 * 60 * 60 * 1000)
    .toTimeString()
    .slice(0, 5);
  const reservaId = await insertReserva(data, inicio, fim);

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
    .delete(`/api/salas/reservas/${reservaId}`)
    .set('Authorization', `Bearer ${userToken}`)
    .expect(400);

});

test('Admin altera status', async () => {
  const reservaId = await insertReserva('2025-10-10', '09:00', '10:00');
  const app = setupAdminApp();
  const token = adminToken();
  const result = await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, '2025-10-10', '10:00', '11:00', 3, 'pendente', NULL)`
  );
  await supertest(app)
    .patch(`/api/admin/salas/reservas/${reservaId}/status`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: 'confirmada' })
    .expect(200)
    .then(res => {
      assert.equal(res.body.message, 'Status atualizado');
    });
});

test('Admin realiza check-in', async () => {
  const reservaId = await insertReserva('2025-10-10', '09:00', '10:00');
  const app = setupAdminApp();
  const token = adminToken();
  const result = await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, '2025-10-10', '10:00', '11:00', 3, 'pendente', NULL)`
  );
  await supertest(app)
    .post(`/api/admin/salas/reservas/${reservaId}/checkin`)
    .set('Authorization', `Bearer ${adminToken}`)

    .expect(200)
    .then(res => {
      assert.equal(res.body.message, 'Check-in realizado');
    });
});
