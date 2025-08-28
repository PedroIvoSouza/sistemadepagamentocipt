// src/api/adminSalasRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const db = require('../database/db');

const router = express.Router();

// Helpers async for sqlite3
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

// Ensure tables/columns exist
async function ensureTables() {
  await runAsync(`CREATE TABLE IF NOT EXISTS salas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    capacidade INTEGER NOT NULL,
    ativa INTEGER DEFAULT 1
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sala_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    horario_inicio TEXT NOT NULL,
    horario_fim TEXT NOT NULL,
    qtd_pessoas INTEGER NOT NULL,
    FOREIGN KEY(sala_id) REFERENCES salas(id)
  )`);

  // add missing columns
  const salasCols = await allAsync(`PRAGMA table_info(salas)`);
  const salasNames = new Set(salasCols.map(c => c.name.toLowerCase()));
  if (!salasNames.has('status')) {
    await runAsync(`ALTER TABLE salas ADD COLUMN status TEXT DEFAULT 'disponivel'`);
  }

  const reservasCols = await allAsync(`PRAGMA table_info(reservas)`);
  const reservasNames = new Set(reservasCols.map(c => c.name.toLowerCase()));
  if (!reservasNames.has('status')) {
    await runAsync(`ALTER TABLE reservas ADD COLUMN status TEXT DEFAULT 'pendente'`);
  }
  if (!reservasNames.has('usada')) {
    await runAsync(`ALTER TABLE reservas ADD COLUMN usada INTEGER DEFAULT 0`);
  }
}

ensureTables().catch(err => console.error('[adminSalasRoutes] ensureTables', err.message));

// ========== Reservas ==========
// GET /api/admin/salas/reservas - lista calendário com filtros
router.get(
  '/reservas',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    try {
      const { salaId, dataInicio, dataFim } = req.query;
      let sql = `
        SELECT r.*, s.nome AS sala_nome
          FROM reservas r
          JOIN salas s ON s.id = r.sala_id
         WHERE 1=1`;
      const params = [];
      if (salaId) { sql += ' AND r.sala_id = ?'; params.push(salaId); }
      if (dataInicio) { sql += ' AND r.data >= ?'; params.push(dataInicio); }
      if (dataFim) { sql += ' AND r.data <= ?'; params.push(dataFim); }
      const rows = await allAsync(sql, params);
      const resp = rows.map(r => ({
        id: r.id,
        sala_id: r.sala_id,
        sala_nome: r.sala_nome,
        inicio: `${r.data}T${r.horario_inicio}`,
        fim: `${r.data}T${r.horario_fim}`,
        status: r.status,
        usada: Boolean(r.usada)
      }));
      res.json(resp);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao listar reservas.' });
    }
  }
);

// POST /api/admin/salas/reservas - cria reserva manual
router.post(
  '/reservas',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const { sala_id, data, horario_inicio, horario_fim, qtd_pessoas = 0, status = 'pendente' } = req.body || {};
    if (!sala_id || !data || !horario_inicio || !horario_fim) {
      return res.status(400).json({ error: 'Campos obrigatórios: sala_id, data, horario_inicio, horario_fim.' });
    }
    try {
      await runAsync(
        `INSERT INTO reservas (sala_id, data, horario_inicio, horario_fim, qtd_pessoas, status, usada)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [sala_id, data, horario_inicio, horario_fim, qtd_pessoas, status]
      );
      res.status(201).json({ message: 'Reserva criada' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao criar reserva.' });
    }
  }
);

// PUT /api/admin/salas/reservas/:id - edita ou marca uso
router.put(
  '/reservas/:id',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { data, horario_inicio, horario_fim, sala_id, status, usada } = req.body || {};
    try {
      const updates = [];
      const params = [];
      if (data) { updates.push('data = ?'); params.push(data); }
      if (horario_inicio) { updates.push('horario_inicio = ?'); params.push(horario_inicio); }
      if (horario_fim) { updates.push('horario_fim = ?'); params.push(horario_fim); }
      if (sala_id) { updates.push('sala_id = ?'); params.push(sala_id); }
      if (status) { updates.push('status = ?'); params.push(status); }
      if (typeof usada === 'boolean') { updates.push('usada = ?'); params.push(usada ? 1 : 0); }
      if (!updates.length) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
      }
      params.push(id);
      await runAsync(`UPDATE reservas SET ${updates.join(', ')} WHERE id = ?`, params);
      res.json({ message: 'Reserva atualizada' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao atualizar reserva.' });
    }
  }
);

// Compat: PATCH /reservas/:id/status
router.patch(
  '/reservas/:id/status',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'Status é obrigatório.' });
    try {
      await runAsync(`UPDATE reservas SET status = ? WHERE id = ?`, [status, id]);
      res.json({ message: 'Status atualizado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao atualizar status.' });
    }
  }
);

// Compat: POST /reservas/:id/checkin
router.post(
  '/reservas/:id/checkin',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await runAsync(`UPDATE reservas SET usada = 1 WHERE id = ?`, [id]);
      res.json({ message: 'Check-in realizado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao registrar check-in.' });
    }
  }
);

// ========== Salas ==========
// GET /api/admin/salas - lista todas as salas
router.get(
  '/',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (_req, res) => {
    try {
      const salas = await allAsync(`SELECT id, nome, capacidade, status FROM salas`);
      res.json(salas);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao listar salas.' });
    }
  }
);

// PUT /api/admin/salas/:id/status - atualiza status da sala
router.put(
  '/:id/status',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    const valid = ['disponivel', 'manutencao', 'indisponivel'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    try {
      await runAsync(`UPDATE salas SET status = ? WHERE id = ?`, [status, id]);
      res.json({ message: 'Status da sala atualizado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao atualizar status da sala.' });
    }
  }
);

module.exports = router;

