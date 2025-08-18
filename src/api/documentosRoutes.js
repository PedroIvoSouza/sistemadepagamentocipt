const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const router = express.Router();
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

router.get('/verify/:token', (req, res) => {
  const token = req.params.token;
  db.get(
    `SELECT id, token, tipo, permissionario_id, created_at FROM documentos WHERE token = ?`,
    [token],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
      if (!row) return res.status(404).json({ error: 'Token inválido.' });
      return res.json(row);
    }
  );
});

module.exports = router;
