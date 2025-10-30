const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const {
  listarEspacos,
  criarEspaco,
  atualizarEspaco,
  definirStatusEspaco,
} = require('../services/espacosEventoService');
const { getTabelaPrecosSnapshot } = require('../services/eventoValorService');

const router = express.Router();

function parseBoolean(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

router.get(
  '/',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const incluirInativos = parseBoolean(req.query?.inativos) || parseBoolean(req.query?.todos);
      const espacos = await listarEspacos({ incluirInativos });
      const snapshot = getTabelaPrecosSnapshot();
      res.json({
        espacos,
        tabelasPreco: snapshot.tabelas,
        aliases: snapshot.aliases,
      });
    } catch (err) {
      console.error('[admin/espacos-evento] ERRO GET /:', err);
      res.status(500).json({ error: 'Falha ao listar os espaços de eventos.' });
    }
  }
);

router.post(
  '/',
  [authMiddleware, authorizeRole(['SUPER_ADMIN'])],
  async (req, res) => {
    try {
      const novo = await criarEspaco(req.body || {});
      res.status(201).json({ ok: true, espaco: novo });
    } catch (err) {
      const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
      if (status === 500) console.error('[admin/espacos-evento] ERRO POST /:', err);
      res.status(status).json({ error: err?.message || 'Falha ao criar o espaço.' });
    }
  }
);

router.put(
  '/:id',
  [authMiddleware, authorizeRole(['SUPER_ADMIN'])],
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Identificador inválido.' });
      }
      const atualizado = await atualizarEspaco(id, req.body || {});
      res.json({ ok: true, espaco: atualizado });
    } catch (err) {
      const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
      if (status === 500) console.error('[admin/espacos-evento] ERRO PUT /:id:', err);
      res.status(status).json({ error: err?.message || 'Falha ao atualizar o espaço.' });
    }
  }
);

router.patch(
  '/:id/status',
  [authMiddleware, authorizeRole(['SUPER_ADMIN'])],
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Identificador inválido.' });
      }
      const ativo = parseBoolean(req.body?.ativo);
      const atualizado = await definirStatusEspaco(id, ativo);
      res.json({ ok: true, espaco: atualizado });
    } catch (err) {
      const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
      if (status === 500) console.error('[admin/espacos-evento] ERRO PATCH /:id/status:', err);
      res.status(status).json({ error: err?.message || 'Falha ao atualizar o status do espaço.' });
    }
  }
);

module.exports = router;
