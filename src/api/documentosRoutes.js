const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const router = express.Router();
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

router.get('/verify/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const row = await dbGet(
      `SELECT id, token, tipo, permissionario_id, created_at FROM documentos WHERE token = ?`,
      [token]
    );
    if (!row) return res.status(404).json({ error: 'Token inválido.' });
    if (row.tipo === 'oficio') {
      const audit = await dbGet(`SELECT pdf_path FROM oficios_audit WHERE documento_id = ?`, [row.id]);
      if (audit && audit.pdf_path) row.pdf_url = audit.pdf_path;
    }
    return res.json(row);
  } catch (err) {
    console.error('[documentos] verify erro:', err);
    return res.status(500).json({ error: 'Erro de banco de dados.' });
  }
});

module.exports = router;
