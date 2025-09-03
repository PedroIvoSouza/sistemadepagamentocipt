// src/api/salasRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../database/db');
const reservaSalaService = require('../services/reservaSalaService');
const reservaAuditService = require('../services/reservaAuditService');

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

// Disponibilidade da sala por dia (retorna apenas intervalos já reservados)
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
    const intervalos = reservas.map(r => ({ inicio: r.hora_inicio, fim: r.hora_fim }));
    res.json(intervalos);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao verificar disponibilidade.' });
  }
});

// Reservas futuras do usuário
router.get('/minhas-reservas', async (req, res) => {
  try {
    const reservas = await allAsync(
      `SELECT r.id, s.numero AS sala, r.data, r.hora_inicio, r.hora_fim
         FROM reservas_salas r
         JOIN salas_reuniao s ON r.sala_id = s.id
        WHERE r.permissionario_id = ?
          AND datetime(r.data || 'T' || r.hora_fim) >= datetime('now')
        ORDER BY r.data, r.hora_inicio`,
      [req.user.id]
    );
    res.json(reservas);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar reservas.' });
  }
});

// Reservas da sala em intervalo
router.get('/:id/reservas', async (req, res) => {
  const salaId = parseInt(req.params.id, 10);
  const { inicio, fim } = req.query;
  if (!inicio || !fim) {
    return res.status(400).json({
      error: 'Parâmetros inicio e fim são obrigatórios (AAAA-MM-DD).'
    });
  }
  try {
    const reservas = await allAsync(
      `SELECT id, data, hora_inicio, hora_fim, status
         FROM reservas_salas
        WHERE sala_id = ? AND data BETWEEN ? AND ?
        ORDER BY data, hora_inicio`,
      [salaId, inicio, fim]
    );
    const resp = reservas.map(r => ({
      id: r.id,
      inicio: `${r.data}T${r.hora_inicio}`,
      fim: `${r.data}T${r.hora_fim}`,
      status: r.status
    }));
    res.json(resp);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar reservas.' });
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
  try {
    const inicio = new Date(`${data}T${horario_inicio}:00`);
    const fim = new Date(`${data}T${horario_fim}:00`);
    if (isNaN(inicio) || isNaN(fim) || inicio >= fim || inicio.toDateString() !== fim.toDateString()) {
      return res.status(400).json({ error: 'Horários inválidos.' });
    }

    await reservaSalaService.verificarConflito(
      sala_id,
      data,
      horario_inicio,
      horario_fim
    );

    const permissionarioId = req.user.id;
    await reservaSalaService.verificarClienteInapto(permissionarioId);
    await reservaSalaService.verificarDiasConsecutivos(permissionarioId, sala_id, data);
    const result = await runAsync(
      `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
       VALUES (?, ?, ?, ?, ?, ?, 'pendente', NULL)`,
      [sala_id, permissionarioId, data, horario_inicio, horario_fim, qtd_pessoas]
    );
    await reservaAuditService.logCriacao(result.lastID, { sala_id, permissionario_id: permissionarioId, data, horario_inicio, horario_fim, participantes: qtd_pessoas });
    res.status(201).json({ id: result.lastID });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao criar reserva.' });
  }
});

// Cancela reserva (≥24h antes)
router.delete('/reservas/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const reserva = await getAsync(`SELECT * FROM reservas_salas WHERE id = ?`, [id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva não encontrada.' });
    if (reserva.permissionario_id !== req.user.id) {
      return res.status(403).json({ error: 'Reserva pertencente a outro permissionário' });
    }
    const inicio = new Date(`${reserva.data}T${reserva.hora_inicio}:00`);
    const diff = inicio.getTime() - Date.now();
    if (diff < 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Cancelamento permitido apenas com 24h de antecedência.' });
    }
    await runAsync(`DELETE FROM reservas_salas WHERE id = ?`, [id]);
    await reservaAuditService.logCancelamento(id, { permissionario_id: req.user.id });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: 'Erro ao cancelar reserva.' });
  }
});

module.exports = router;
