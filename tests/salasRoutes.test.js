const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const path = require('path');

process.env.JWT_SECRET = 'testsecret';
process.env.SQLITE_STORAGE = path.resolve(__dirname, 'salas.test.db');

const db = require('../src/database/db');

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function resetDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DROP TABLE IF EXISTS reservas_salas');
      db.run('DROP TABLE IF EXISTS salas_reuniao');
      db.run('DROP TABLE IF EXISTS reservas_audit');
      db.run('CREATE TABLE salas_reuniao (id INTEGER PRIMARY KEY, numero TEXT, capacidade INTEGER, status TEXT)');
      db.run(
        'CREATE TABLE reservas_salas (id INTEGER PRIMARY KEY, sala_id INTEGER, permissionario_id INTEGER, data TEXT, hora_inicio TEXT, hora_fim TEXT, participantes INTEGER, status TEXT, checkin TEXT)',
        err => {
          if (err) return reject(err);
          db.run('CREATE TABLE reservas_audit (id INTEGER PRIMARY KEY, reserva_id INTEGER, acao TEXT, detalhes TEXT)', err2 => {
            if (err2) return reject(err2);
            db.run("INSERT INTO salas_reuniao (id, numero, capacidade, status) VALUES (1, 'Sala 1', 5, 'disponivel')", err3 => err3 ? reject(err3) : resolve());
          });
        }
      );
    });
  });
}

beforeEach(resetDb);

const userToken = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
const adminToken = jwt.sign({ id: 999, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET);

function setupUserApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/salas', require('../src/api/salasRoutes'));
  return app;
}

function setupAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/salas', require('../src/api/adminSalasRoutes'));
  return app;
}

function insertReserva(data, inicio, fim, permissionario = 1) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
       VALUES (1, ?, ?, ?, ?, 3, 'pendente', NULL)`,
      [permissionario, data, inicio, fim],
      function (err) { if (err) reject(err); else resolve(this.lastID); }
    );
  });
}

test('Reserva válida', async () => {
  const app = setupUserApp();
  let newId;
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ sala_id:1, data:'2025-10-10', horario_inicio:'09:00', horario_fim:'10:00', qtd_pessoas:2 })
    .expect(201)
    .then(res => { newId = res.body.id; assert.ok(newId); });
  const audit = await allAsync('SELECT * FROM reservas_audit WHERE reserva_id = ?', [newId]);
  assert.equal(audit[0].acao, 'CRIACAO');
});

test('Bloqueia reserva em dias consecutivos', async () => {
  await insertReserva('2025-10-10','09:00','10:00');
  const app = setupUserApp();
  await supertest(app)
    .post('/api/salas/reservas')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ sala_id:1, data:'2025-10-11', horario_inicio:'09:00', horario_fim:'10:00', qtd_pessoas:2 })
    .expect(400)
    .then(res => assert.equal(res.body.error, 'Não é permitido reservar sala em dias consecutivos.'));
});

test('Lista disponibilidade retorna reservas existentes', async () => {
  await insertReserva('2025-10-10','09:00','10:30');
  const app = setupUserApp();
  await supertest(app)
    .get('/api/salas/1/disponibilidade?data=2025-10-10')
    .set('Authorization', `Bearer ${userToken}`)
    .expect(200)
    .then(res => {
      assert.deepEqual(res.body, [{ inicio: '09:00', fim: '10:30' }]);
    });
});

test('Cancelamento com menos de 24h', async () => {
  const agora = new Date();
  const data = agora.toISOString().slice(0,10);
  const inicio = new Date(agora.getTime()+60*60*1000).toTimeString().slice(0,5);
  const fim = new Date(agora.getTime()+2*60*60*1000).toTimeString().slice(0,5);
  const reservaId = await insertReserva(data, inicio, fim);
  const app = setupUserApp();
  await supertest(app)
    .delete(`/api/salas/reservas/${reservaId}`)
    .set('Authorization', `Bearer ${userToken}`)
    .expect(400);
});

test('Cancelamento cria auditoria', async () => {
  const reservaId = await insertReserva('2030-10-10','09:00','10:00');
  const app = setupUserApp();
  await supertest(app)
    .delete(`/api/salas/reservas/${reservaId}`)
    .set('Authorization', `Bearer ${userToken}`)
    .expect(204);
  const audit = await allAsync('SELECT * FROM reservas_audit WHERE reserva_id = ?', [reservaId]);
  assert.equal(audit[0].acao, 'CANCELAMENTO');
});

test('Admin altera status', async () => {
  const reservaId = await insertReserva('2025-10-10','09:00','10:00');
  const app = setupAdminApp();
  await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, '2025-10-10', '10:00', '11:00', 3, 'pendente', NULL)`
  );

  await supertest(app)
    .patch(`/api/admin/salas/reservas/${reservaId}/status`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status:'confirmada' })
    .expect(200)
    .then(res => assert.equal(res.body.message, 'Status atualizado'));
  const audit = await allAsync('SELECT * FROM reservas_audit WHERE reserva_id = ?', [reservaId]);
  assert.equal(audit[0].acao, 'ATUALIZACAO');
});

test('Admin realiza check-in', async () => {
  const reservaId = await insertReserva('2025-10-10','09:00','10:00');
  const app = setupAdminApp();
  await runAsync(
    `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
     VALUES (1, 1, '2025-10-10', '10:00', '11:00', 3, 'pendente', NULL)`
  );

  await supertest(app)
    .post(`/api/admin/salas/reservas/${reservaId}/uso`)
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(200)
    .then(res => assert.equal(res.body.message, 'Uso registrado'));
  const audit = await allAsync('SELECT * FROM reservas_audit WHERE reserva_id = ?', [reservaId]);
  assert.equal(audit[0].acao, 'CHECKIN');
});
