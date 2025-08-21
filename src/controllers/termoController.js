// src/controllers/termoController.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { prepararTermoEventoSemCampos } = require('../services/termoAssinafyService');

const DB_PATH = process.env.SQLITE_STORAGE || path.resolve(process.cwd(), './sistemacipt.db');

async function findPdfForEvento(eventoId) {
  const db = new sqlite3.Database(DB_PATH);
  const get = (sql, p=[]) => new Promise((res, rej)=>db.get(sql, p, (e,r)=>e?rej(e):res(r)));
  try {
    const doc = await get(`
      SELECT pdf_url, pdf_public_url
        FROM documentos
       WHERE evento_id = ? AND tipo = 'termo_evento'
       ORDER BY id DESC LIMIT 1;`, [String(eventoId)]);
    if (!doc?.pdf_url) throw new Error('PDF do termo não encontrado no banco. Gere o PDF antes.');
    return { pdfPath: path.resolve(doc.pdf_url), filename: path.basename(doc.pdf_url) };
  } finally { db.close(); }
}

/**
 * POST /api/eventos/:id/termo/preparar
 * body: { full_name, email, government_id?, phone? }
 * Dispara a preparação (SEM CAMPOS) na Assinafy
 */
async function prepararSemCamposController(req, res) {
  try {
    const eventoId = req.params.id;
    const { pdfPath, filename } = await findPdfForEvento(eventoId);
    const { full_name, email, government_id, phone } = req.body || {};

    const r = await prepararTermoEventoSemCampos({
      eventoId,
      pdfPath,
      pdfFilename: filename,
      signer: { full_name, email, government_id, phone },
    });

    res.json({ ok: true, message: 'Documento preparado para assinatura (virtual).', data: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

module.exports = { prepararSemCamposController };
