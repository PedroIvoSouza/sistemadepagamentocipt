// src/api/portalAssinaturaRoutes.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const { uploadPdf, getDocumentStatus } = require('../services/assinafyClient');

// --- env para o proxy de download ---
const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const BASE = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
function apiHeaders() {
  const h = {};
  if (API_KEY) {
    h['X-Api-Key'] = API_KEY;
    h['X-API-KEY'] = API_KEY;
    h['x-api-key'] = API_KEY;
  }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
  return h;
}

// --- DB ---
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

// Routers
const portalEventosAssinaturaRouter = express.Router();     // para cliente logado (monte em /api/portal/eventos)
const documentosAssinafyPublicRouter = express.Router();    // público p/ abrir PDF (monte em /api)

// TODO: se quiser exigir auth aqui, adicione seu middleware de auth do cliente:
// portalEventosAssinaturaRouter.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO']));

// Utilitário: achar/garantir PDF do termo desse evento
async function getTermoDocRegistro(eventoId) {
  // documentos: id, evento_id, tipo, pdf_url, assinafy_id, status, ...
  const doc = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
  return doc || null;
}

// POST /:id/termo/assinafy/link
// Faz upload do PDF do termo, grava assinafy_id e devolve uma URL da SUA API que o browser pode abrir.
portalEventosAssinaturaRouter.post('/:id/termo/assinafy/link', async (req, res) => {
  try {
    const eventoId = req.params.id;

    // 1) busca registro do termo
    let doc = await getTermoDocRegistro(eventoId);
    if (!doc || !doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
      return res.status(409).json({ error: 'PDF do termo não encontrado. Gere o termo antes.' });
    }

    // 2) se já tem assinafy_id, reutiliza
    if (doc.assinafy_id) {
      const openUrl = `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`;
      return res.json({ ok: true, id: doc.assinafy_id, url: openUrl });
    }

    // 3) upload agora
    const pdfBuffer = fs.readFileSync(doc.pdf_url);
    const filename = path.basename(doc.pdf_url);
    const payload = await uploadPdf(pdfBuffer, filename, { callbackUrl: process.env.ASSINAFY_CALLBACK_URL });

    if (!payload?.id) {
      return res.status(502).json({ error: 'Assinafy não retornou identificador do documento.' });
    }

    await dbRun(`UPDATE documentos SET assinafy_id=?, status='uploaded' WHERE id=?`, [payload.id, doc.id]);

    const openUrl = `/api/documentos/assinafy/${encodeURIComponent(payload.id)}/open`;
    res.json({ ok: true, id: payload.id, url: openUrl });
  } catch (e) {
    console.error('[PORTAL] assinafy link erro:', e?.response?.data || e);
    const msg = e?.message || 'Falha ao iniciar assinatura.';
    res.status(500).json({ error: msg });
  }
});

// GET /documentos/assinafy/:id/open
// Abre o PDF do documento (assinado se disponível, senão o original) via proxy, SEM expor sua chave ao browser.
documentosAssinafyPublicRouter.get('/documentos/assinafy/:id/open', async (req, res) => {
  try {
    const id = req.params.id;
    const info = await getDocumentStatus(id);

    const artifacts = info?.artifacts || {};
    const url = artifacts.certificated || artifacts.original;
    if (!url) {
      return res.status(404).send('Documento sem artefato disponível.');
    }

    // baixa do endpoint protegido usando suas credenciais e faz stream para o browser
    const ax = await axios.get(url, {
      responseType: 'stream',
      headers: { ...apiHeaders(), Accept: 'application/pdf' },
      maxBodyLength: Infinity,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(info?.name || 'documento')}.pdf"`);
    ax.data.pipe(res);
  } catch (e) {
    const st = e?.response?.status || 500;
    const body = e?.response?.data;
    console.error('[DOC/OPEN] erro:', st, body || e.message);
    if (st === 401) return res.status(502).send('Falha ao abrir documento (credenciais inválidas no servidor).');
    res.status(502).send('Não foi possível abrir o documento agora.');
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
