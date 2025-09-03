// src/api/advertenciasRoutes.js
const express = require('express');
const db = require('../database/db');

const router = express.Router();

// Helpers DB
const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

// GET /api/advertencias/token/:token
// Retorna metadados da advertência para verificação de autenticidade
router.get('/token/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const row = await getAsync(
      `SELECT id, evento_id, cliente_id, texto_fatos, clausulas_json, token, pdf_url, status, createdAt, updatedAt
         FROM Advertencias WHERE token = ?`,
      [token]
    );
    if (!row) {
      return res.status(404).json({ error: 'Advertência não encontrada.' });
    }
    res.json(row);
  } catch (e) {
    console.error('[advertencias] token lookup error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar advertência.' });
  }
});

module.exports = router;
