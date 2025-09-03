const express = require('express');
const nodemailer = require('nodemailer');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const db = require('../database/db');
const termoClausulas = require('../constants/termoClausulas');

const router = express.Router();
router.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO']));

router.get('/clausulas', (_req, res) => res.json(termoClausulas));

// DB helpers
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});

async function ensureColumns() {
  await dbRun(`ALTER TABLE advertencias ADD COLUMN recurso_texto TEXT`).catch(() => {});
  await dbRun(`ALTER TABLE advertencias ADD COLUMN recurso_data TEXT`).catch(() => {});
}

async function notifyAdmins(advertenciaId, texto) {
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = (process.env.SMTP_PASS || process.env.EMAIL_PASS || '').replace(/\s+/g, '');
  const to = process.env.ADMIN_ALERT_EMAIL || user;
  if (!host || !user || !pass || !to) {
    console.warn('[MAIL] Configuração ausente, recurso não notificado.');
    console.log(`[MAIL][DRY-RUN] recurso advertencia ${advertenciaId}: ${texto}`);
    return;
  }
  try {
    const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || user,
      to,
      subject: `Recurso de advertência #${advertenciaId}`,
      text: texto,
    });
  } catch (err) {
    console.error('[MAIL][ERRO] recurso advertencia:', err.message);
  }
}

/**
 * POST /api/portal/advertencias/:id/recorrer
 * Cliente envia recurso para uma advertência.
 */
router.post('/:id/recorrer', async (req, res) => {
  try {
    await ensureColumns();
    const advertenciaId = req.params.id;
    const { texto } = req.body || {};
    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ error: 'Texto do recurso é obrigatório.' });
    }

    const adv = await dbGet(`SELECT a.*, e.id_cliente AS cliente_id FROM advertencias a JOIN Eventos e ON e.id = a.evento_id WHERE a.id = ?`, [advertenciaId]);
    if (!adv) return res.status(404).json({ error: 'Advertência não encontrada.' });
    if (Number(adv.cliente_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Advertência não pertence ao usuário.' });
    }
    if (adv.status && adv.status !== 'emitida') {
      return res.status(400).json({ error: 'Advertência já possui recurso ou foi resolvida.' });
    }
    if (adv.prazo_recurso) {
      const prazo = new Date(adv.prazo_recurso);
      const now = new Date();
      if (now > prazo) {
        return res.status(400).json({ error: 'Prazo para recurso expirado.' });
      }
    }

    const recursoData = new Date().toISOString();
    await dbRun(`UPDATE advertencias SET status = ?, recurso_texto = ?, recurso_data = ? WHERE id = ?`, ['recurso_solicitado', texto, recursoData, advertenciaId]);

    await notifyAdmins(advertenciaId, texto);

    res.json({ ok: true });
  } catch (err) {
    console.error('[PORTAL][ADVERTENCIAS] recurso erro:', err.message);
    res.status(500).json({ error: 'Erro ao registrar recurso.' });
  }
});

module.exports = router;

