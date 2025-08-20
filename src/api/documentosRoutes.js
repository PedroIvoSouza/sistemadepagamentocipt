const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const assinafyService = require('../services/assinafyService');

const router = express.Router();
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve(this);
  }));

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

router.post('/:id/sign-assinafy', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await dbGet('SELECT id, pdf_url FROM documentos WHERE id = ?', [id]);
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });
    let pdfBuffer;

    if (doc.pdf_url) {
      const url = String(doc.pdf_url);
      if (/^data:application\/pdf;base64,/i.test(url)) {
        const b64 = url.replace(/^data:application\/pdf;base64,/i, '');
        pdfBuffer = Buffer.from(b64, 'base64');
      } else if (fs.existsSync(url)) {
        pdfBuffer = fs.readFileSync(url);
      }
    }
    if (!pdfBuffer) {
      const audit = await dbGet('SELECT pdf_path FROM oficios_audit WHERE documento_id = ?', [id]);
      if (audit?.pdf_path && fs.existsSync(audit.pdf_path)) {
        pdfBuffer = fs.readFileSync(audit.pdf_path);
      }
    }
    if (!pdfBuffer) return res.status(404).json({ error: 'PDF não encontrado.' });

    const options = req.body || {};
    const resp = await assinafyService.uploadPdf(pdfBuffer, `documento_${id}.pdf`, options);
    if (resp?.id) {
      await dbRun('UPDATE documentos SET assinafy_id = ? WHERE id = ?', [resp.id, id]);
    }
    res.json({ url: resp?.embedUrl || resp?.url || resp?.signUrl || resp?.redirectUrl || null, assinafyId: resp?.id });
  } catch (err) {
    console.error('[documentos] sign-assinafy erro:', err);
    res.status(500).json({ error: 'Falha ao enviar para assinatura.' });
  }
});

router.get('/assinafy/callback', async (req, res) => {
  const assinafyId = req.query.id || req.query.documentId;
  const documentoId = req.query.documentoId || req.query.localId || null;
  if (!assinafyId) return res.status(400).send('id ausente');

  try {
    const info = await assinafyService.getDocumentStatus(assinafyId);
    const pdfBuffer = await assinafyService.downloadSignedPdf(assinafyId);

    const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const signer = info?.signer?.name || (info?.signatures && info.signatures[0]?.signer) || '';
    const signedAt = info?.signedAt || new Date().toISOString();

    const dir = path.resolve(process.cwd(), 'public', 'assinados');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `documento_${assinafyId}.pdf`);
    fs.writeFileSync(filePath, pdfBuffer);

    await dbRun(`CREATE TABLE IF NOT EXISTS assinafy_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER,
      assinafy_id TEXT,
      hash TEXT,
      signer TEXT,
      signed_at TEXT,
      pdf_path TEXT
    )`);

    await dbRun(
      `INSERT INTO assinafy_audit (documento_id, assinafy_id, hash, signer, signed_at, pdf_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [documentoId, assinafyId, hash, signer, signedAt, filePath]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[assinafy callback] erro:', err);
    res.status(500).json({ error: 'Erro no callback.' });
  }
});

router.get('/:id/sign-assinafy-status', async (req, res) => {
  try {
    const id = req.params.id;
    await dbRun(`CREATE TABLE IF NOT EXISTS assinafy_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER,
      assinafy_id TEXT,
      hash TEXT,
      signer TEXT,
      signed_at TEXT,
      pdf_path TEXT
    )`);
    const row = await dbGet(
      'SELECT hash, signer, signed_at, pdf_path FROM assinafy_audit WHERE documento_id = ? ORDER BY id DESC LIMIT 1',
      [id]
    );
    if (!row) return res.json({ status: 'pending' });
    res.json({ status: 'signed', ...row });
  } catch (err) {
    console.error('[documentos] status erro:', err);
    res.status(500).json({ error: 'Erro ao consultar status.' });
  }
});

module.exports = router;

