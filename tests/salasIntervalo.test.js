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
        'CREATE TABLE salas_reuniao (id INTEGER PRIMARY KEY, numero TEXT, capacidade INTEGER, status TEXT)'
      );
      db.run(
        'CREATE TABLE reservas_salas (id INTEGER PRIMARY KEY, sala_id INTEGER, permissionario_id INTEGER, data TEXT, hora_inicio TEXT, hora_fim TEXT, participantes INTEGER, status TEXT, checkin TEXT)',
        err => {
          if (err) return reject(err);
          db.run(
            "INSERT INTO salas_reuniao (id, numero, capacidade, status) VALUES (1, 'Sala 1', 5, 'disponivel')",
            err2 => (err2 ? reject(err2) : resolve())
          );
        }
      );
    });
  });
}

beforeEach(resetDb);

const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);

function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/salas', require('../src/api/salasRoutes'));
  return app;
}

function inserirReserva(data, inicio, fim) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
       VALUES (1, 1, ?, ?, ?, 3, 'pendente', NULL)`,
      [data, inicio, fim],
      function (err) {
        if (err) reject(err); else resolve(this.lastID);
      }
    );
  });
}

test('lista reservas por intervalo', async () => {
  await inserirReserva('2025-10-10', '09:00', '10:00');
  await inserirReserva('2025-10-12', '14:00', '15:00');
  const app = setupApp();
  await supertest(app)
    .get('/api/salas/1/reservas?inicio=2025-10-09&fim=2025-10-11')
    .set('Authorization', `Bearer ${token}`)
    .expect(200)
    .then(res => {
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0].inicio, '2025-10-10T09:00');
      assert.equal(res.body[0].fim, '2025-10-10T10:00');
    });
});
