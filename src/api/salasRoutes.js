// src/api/salasRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../database/db');

const router = express.Router();

// Helpers promessas
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
// Aplica auth
router.use(authMiddleware);

// Lista salas ativas
router.get('/', async (_req, res) => {
  try {
    const salas = await allAsync(
      `SELECT id, numero AS nome, capacidade FROM salas_reuniao WHERE status = 'disponivel'`
    );
    res.json(salas);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar salas.' });
  }
});

const HORARIOS_PADRAO = [
  '08:00', '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00'
];
const somaHora = h => {
  const [hr, min] = h.split(':').map(Number);
  const d = new Date(0, 0, 0, hr, min, 0);
  d.setHours(d.getHours() + 1);
  return d.toTimeString().slice(0,5);
};

// Disponibilidade da sala por dia
router.get('/:id/disponibilidade', async (req, res) => {
  const salaId = parseInt(req.params.id, 10);
  const data = req.query.data;
  if (!data) {
    return res.status(400).json({ error: 'Parâmetro data é obrigatório (AAAA-MM-DD).' });
  }
  try {
    const reservas = await allAsync(
      `SELECT hora_inicio, hora_fim FROM reservas_salas WHERE sala_id = ? AND data = ?`,
      [salaId, data]
    );
    const ocupados = new Set();
    reservas.forEach(r => {
      let h = r.hora_inicio;
      while (h < r.hora_fim) {
        ocupados.add(h);
        h = somaHora(h);
      }
    });
    const livres = HORARIOS_PADRAO.filter(h => !ocupados.has(h));
    res.json({ horarios: livres });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao verificar disponibilidade.' });
  }
});

// Cria reserva com validações
router.post('/reservas', async (req, res) => {
  const { sala_id, data, horario_inicio, horario_fim, qtd_pessoas } = req.body || {};
  if (!sala_id || !data || !horario_inicio || !horario_fim || !qtd_pessoas) {
    return res.status(400).json({
      error: 'Campos obrigatórios: sala_id, data, horario_inicio, horario_fim, qtd_pessoas.'
    });
  }
  if (qtd_pessoas < 3) {
    return res.status(400).json({ error: 'Reserva requer pelo menos 3 pessoas.' });
  }
  try {
    const sala = await getAsync(`SELECT * FROM salas_reuniao WHERE id = ? AND status = 'disponivel'`, [sala_id]);
    if (!sala) return res.status(404).json({ error: 'Sala não encontrada ou inativa.' });
    if (qtd_pessoas > sala.capacidade) {
      return res.status(400).json({ error: 'Capacidade da sala excedida.' });
    }

    const inicio = new Date(`${data}T${horario_inicio}:00`);
    const fim = new Date(`${data}T${horario_fim}:00`);
    if (isNaN(inicio) || isNaN(fim) || inicio >= fim) {
      return res.status(400).json({ error: 'Horários inválidos.' });
    }
    if (inicio.toDateString() !== fim.toDateString()) {
      return res.status(400).json({ error: 'Reserva deve ocorrer em único dia.' });
    }

    const prevDate = new Date(inicio); prevDate.setDate(prevDate.getDate() - 1);
    const nextDate = new Date(inicio); nextDate.setDate(nextDate.getDate() + 1);
    const permissionarioId = req.user.id;
    const consec = await getAsync(
      `SELECT id FROM reservas_salas WHERE permissionario_id = ? AND data IN (?, ?)`,
      [permissionarioId, prevDate.toISOString().slice(0,10), nextDate.toISOString().slice(0,10)]
    );
    if (consec) {
      return res.status(400).json({ error: 'Não é permitido reservar dias consecutivos.' });
    }

    const conflito = await getAsync(
      `SELECT id FROM reservas_salas
         WHERE sala_id = ? AND data = ?
           AND NOT (? >= hora_fim OR ? <= hora_inicio)`,
      [sala_id, data, horario_inicio, horario_fim]
    );
    if (conflito) {
      return res.status(400).json({ error: 'Horário indisponível para a sala.' });
    }

    const result = await runAsync(
      `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
       VALUES (?, ?, ?, ?, ?, ?, 'pendente', NULL)`,
      [sala_id, permissionarioId, data, horario_inicio, horario_fim, qtd_pessoas]
    );
    res.status(201).json({ id: result.lastID });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar reserva.' });
  }
});

// Cancela reserva (≥24h antes)
router.delete('/reservas/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const reserva = await getAsync(`SELECT * FROM reservas_salas WHERE id = ?`, [id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva não encontrada.' });
    const inicio = new Date(`${reserva.data}T${reserva.hora_inicio}:00`);
    const diff = inicio.getTime() - Date.now();
    if (diff < 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Cancelamento permitido apenas com 24h de antecedência.' });
    }
    await runAsync(`DELETE FROM reservas_salas WHERE id = ?`, [id]);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: 'Erro ao cancelar reserva.' });
  }
});

module.exports = router;
