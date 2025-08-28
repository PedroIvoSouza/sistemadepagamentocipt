// src/api/adminSalasRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const db = require('../database/db');
const reservaSalaService = require('../services/reservaSalaService');
const reservaAuditService = require('../services/reservaAuditService');

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

// ========== Reservas ==========
// GET /api/admin/salas/reservas - lista calendário com filtros
router.get(
  '/reservas',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    try {
      const { salaId = '', dataInicio = '', dataFim = '' } = req.query;
      let sql = `
        SELECT r.*, s.numero AS sala_nome
          FROM reservas_salas r
          JOIN salas_reuniao s ON s.id = r.sala_id
         WHERE 1=1`;
      const params = [];

      if (salaId) {
        const idNum = parseInt(salaId, 10);
        if (Number.isNaN(idNum)) {
          return res.status(400).json({ error: 'salaId inválido' });
        }
        sql += ' AND r.sala_id = ?';
        params.push(idNum);
      }
      if (dataInicio) {
        if (isNaN(Date.parse(dataInicio))) {
          return res.status(400).json({ error: 'dataInicio inválida' });
        }
        sql += ' AND r.data >= ?';
        params.push(dataInicio);
      }
      if (dataFim) {
        if (isNaN(Date.parse(dataFim))) {
          return res.status(400).json({ error: 'dataFim inválida' });
        }
        sql += ' AND r.data <= ?';
        params.push(dataFim);
      }

      const rows = await allAsync(sql, params);
      const resp = rows.map(r => ({
        id: r.id,
        sala_id: r.sala_id,
        sala_nome: r.sala_nome,
        permissionario_id: r.permissionario_id,
        inicio: `${r.data}T${r.hora_inicio}`,
        fim: `${r.data}T${r.hora_fim}`,
        status: r.status,
        usada: Boolean(r.checkin)
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
    const {
      sala_id,
      permissionario_id,
      data,
      horario_inicio,
      horario_fim,
      qtd_pessoas = 0,
      status = 'pendente',
    } = req.body || {};
    if (!sala_id || !permissionario_id || !data || !horario_inicio || !horario_fim) {
      return res.status(400).json({
        error: 'Campos obrigatórios: sala_id, permissionario_id, data, horario_inicio, horario_fim.',
      });
    }
    try {
      await reservaSalaService.validarSalaECapacidade(sala_id, qtd_pessoas);
      reservaSalaService.validarHorarios(data, horario_inicio, horario_fim);
      await reservaSalaService.verificarConflito(
        sala_id,
        data,
        horario_inicio,
        horario_fim
      );

      const result = await runAsync(
        `INSERT INTO reservas_salas (sala_id, permissionario_id, data, hora_inicio, hora_fim, participantes, status, checkin)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [sala_id, permissionario_id, data, horario_inicio, horario_fim, qtd_pessoas, status]
      );
      await reservaAuditService.logCriacao(result.lastID, { sala_id, permissionario_id, data, horario_inicio, horario_fim, participantes: qtd_pessoas, status });
      res.status(201).json({ message: 'Reserva criada' });
    } catch (e) {
      console.error(e);
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao criar reserva.' });
    }
  }
);

// PUT /api/admin/salas/reservas/:id - edita ou marca uso
router.put(
  '/reservas/:id',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const {
      data,
      horario_inicio,
      horario_fim,
      sala_id,
      status,
      usada,
      qtd_pessoas,
      permissionario_id,
      inicio,
      fim,
    } = req.body || {};
    try {
      const atual = await getAsync(`SELECT * FROM reservas_salas WHERE id = ?`, [id]);
      if (!atual) return res.status(404).json({ error: 'Reserva não encontrada.' });

      let finalData = atual.data;
      let finalInicio = atual.hora_inicio;
      let finalFim = atual.hora_fim;
      let finalSala = atual.sala_id;
      let finalQtd = typeof qtd_pessoas === 'number' ? qtd_pessoas : atual.participantes;

      if (inicio) {
        const [d, t] = inicio.split('T');
        finalData = d;
        finalInicio = t.slice(0,5);
      }
      if (fim) {
        const [d, t] = fim.split('T');
        finalData = d;
        finalFim = t.slice(0,5);
      }
      if (data) finalData = data;
      if (horario_inicio) finalInicio = horario_inicio;
      if (horario_fim) finalFim = horario_fim;
      if (sala_id) finalSala = sala_id;

      await reservaSalaService.validarSalaECapacidade(finalSala, finalQtd);
      reservaSalaService.validarHorarios(finalData, finalInicio, finalFim);
      await reservaSalaService.verificarConflito(
        finalSala,
        finalData,
        finalInicio,
        finalFim,
        id
      );

      const updates = [];
      const params = [];
      if (inicio) {
        const [d, t] = inicio.split('T');
        updates.push('data = ?'); params.push(d);
        updates.push('hora_inicio = ?'); params.push(t.slice(0,5));
      }
      if (fim) {
        const [d, t] = fim.split('T');
        if (!inicio) { updates.push('data = ?'); params.push(d); }
        updates.push('hora_fim = ?'); params.push(t.slice(0,5));
      }
      if (data) { updates.push('data = ?'); params.push(data); }
      if (horario_inicio) { updates.push('hora_inicio = ?'); params.push(horario_inicio); }
      if (horario_fim) { updates.push('hora_fim = ?'); params.push(horario_fim); }
      if (sala_id) { updates.push('sala_id = ?'); params.push(sala_id); }
      if (status) { updates.push('status = ?'); params.push(status); }
      if (typeof qtd_pessoas === 'number') { updates.push('participantes = ?'); params.push(qtd_pessoas); }
      if (permissionario_id) { updates.push('permissionario_id = ?'); params.push(permissionario_id); }
      if (typeof usada === 'boolean') {
        updates.push('checkin = ?');
        params.push(usada ? new Date().toISOString() : null);
      }
      if (!updates.length) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
      }
      params.push(id);
      await runAsync(`UPDATE reservas_salas SET ${updates.join(', ')} WHERE id = ?`, params);
      await reservaAuditService.logAtualizacao(id, req.body);
      res.json({ message: 'Reserva atualizada' });
    } catch (e) {
      console.error(e);
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao atualizar reserva.' });
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
      await runAsync(`UPDATE reservas_salas SET status = ? WHERE id = ?`, [status, id]);
      await reservaAuditService.logAtualizacao(id, { status });
      res.json({ message: 'Status atualizado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao atualizar status.' });
    }
  }
);

// POST /reservas/:id/checkin - marca uso da reserva
router.post(
  '/reservas/:id/checkin',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await runAsync(`UPDATE reservas_salas SET checkin = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
      await reservaAuditService.logCheckin(id, {});
      res.json({ message: 'Check-in realizado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao registrar check-in.' });
    }
  }
);

// POST /reservas/:id/uso - alias para check-in
router.post(
  '/reservas/:id/uso',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await runAsync(`UPDATE reservas_salas SET checkin = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
      await reservaAuditService.logCheckin(id, {});
      res.json({ message: 'Uso registrado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao registrar uso.' });
    }
  }
);

// DELETE /reservas/:id - cancela reserva
router.delete(
  '/reservas/:id',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'SALAS_ADMIN'])],
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await runAsync(`UPDATE reservas_salas SET status = 'cancelada' WHERE id = ?`, [id]);
      await reservaAuditService.logCancelamento(id, {});
      res.json({ message: 'Reserva cancelada' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao cancelar reserva.' });
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
      const salas = await allAsync(`SELECT id, numero AS nome, capacidade, status FROM salas_reuniao`);
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
      await runAsync(`UPDATE salas_reuniao SET status = ? WHERE id = ?`, [status, id]);
      res.json({ message: 'Status da sala atualizado' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erro ao atualizar status da sala.' });
    }
  }
);

module.exports = router;

