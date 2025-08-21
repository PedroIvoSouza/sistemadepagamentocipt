// src/api/documentosRoutes.js
const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const sqlite3  = require('sqlite3').verbose();

const { uploadPdf, getDocumentStatus } = require('../integrations/assinafyClient');
const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// helpers de BD
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbAll = (sql, p=[]) => new Promise((res, rej)=> db.all(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

// --- utils
function ensureCallbackUrl() {
  const cb = process.env.ASSINAFY_CALLBACK_URL;
  if (!cb) {
    console.warn('[ASSINAFY] ASSINAFY_CALLBACK_URL não definido. Recomendo configurar, ex: https://SEU_DOMINIO/api/documentos/assinafy/webhook?secret=SEGREDO');
  }
  return cb || '';
}
function publicViewerUrl(assinafyId){
  // Fallback de abertura no app web da Assinafy (ajuste se necessário)
  const app = process.env.ASSINAFY_APP_URL || 'https://app.assinafy.com';
  return `${app}/documents/${encodeURIComponent(assinafyId)}`;
}

// --- GET meta do termo
router.get('/termo/:eventoId', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const doc = await dbGet(
      `SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento'`,
      [eventoId]
    );
    if (!doc) return res.status(404).json({ error: 'Termo não encontrado.' });
    res.json({
      id: doc.id,
      evento_id: doc.evento_id,
      pdf_url: doc.pdf_url,
      pdf_public_url: doc.pdf_public_url,
      assinafy_id: doc.assinafy_id,
      status: doc.status,
      signed_pdf_public_url: doc.signed_pdf_public_url,
      signed_at: doc.signed_at
    });
  } catch (e) {
    console.error('[DOC] meta erro:', e);
    res.status(500).json({ error: 'Falha ao obter metadados do termo.' });
  }
});

// --- POST enviar termo p/ Assinafy
router.post('/termo/:eventoId/enviar-assinafy', async (req, res) => {
  try {
    const { eventoId } = req.params;

    // garante que o PDF existe (gera se não existir)
    let docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    if (!docRow || !docRow.pdf_url || !fs.existsSync(docRow.pdf_url)) {
      console.log('[DOC] Gerando termo antes de enviar…');
      await gerarTermoEventoPdfkitEIndexar(eventoId);
      docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    }
    if (!docRow || !docRow.pdf_url || !fs.existsSync(docRow.pdf_url)) {
      return res.status(409).json({ error: 'PDF do termo não encontrado para envio.' });
    }

    const buffer = fs.readFileSync(docRow.pdf_url);
    const filename = path.basename(docRow.pdf_url);

    const callbackUrl = ensureCallbackUrl();
    const resp = await uploadPdf(buffer, filename, { callbackUrl });

    // resp.id (obrigatório). Alguns provedores devolvem também alguma url de assinatura
    const assinafyId = resp.id;
    const candidateUrl =
      resp.url || resp.signUrl || resp.signerUrl || resp.signingUrl || null;

    await dbRun(
      `UPDATE documentos
         SET assinafy_id = ?, status = 'enviado'
       WHERE id = ?`,
      [assinafyId, docRow.id]
    );

    // devolve tanto uma url direta (se houver) quanto uma rota nossa de fallback
    const open_url = candidateUrl || `/api/documentos/assinafy/${encodeURIComponent(assinafyId)}/open`;

    res.json({
      ok: true,
      id: assinafyId,
      url: candidateUrl,     // pode ser null
      open_url               // garantido
    });
  } catch (e) {
    console.error('[ASSINAFY] enviar erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha no envio para assinatura.' });
  }
});

// --- GET status
router.get('/assinafy/:id/status', async (req, res) => {
  try {
    const data = await getDocumentStatus(req.params.id);
    res.json(data);
  } catch (e) {
    console.error('[ASSINAFY] status erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao consultar status.' });
  }
});

// --- GET open (redirect)
router.get('/assinafy/:id/open', async (req, res) => {
  try {
    // tenta obter uma URL amigável da API; se não, cai no app público
    let url = null;
    try {
      const data = await getDocumentStatus(req.params.id);
      url = data.url || data.signUrl || data.signerUrl || data.signingUrl || null;
    } catch {}
    if (!url) url = publicViewerUrl(req.params.id);
    res.redirect(url);
  } catch (e) {
    console.error('[ASSINAFY] open erro:', e);
    res.status(500).json({ error: 'Falha ao abrir documento para assinatura.' });
  }
});

// --- POST webhook (configure ASSINAFY_CALLBACK_URL para esta rota)
router.post('/assinafy/webhook', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    // segurança mínima: ?secret= no callback (ou header x-assinafy-secret)
    const sent = req.query.secret || req.headers['x-assinafy-secret'];
    const expected = process.env.ASSINAFY_WEBHOOK_SECRET;
    if (!expected || sent !== expected) {
      console.warn('[ASSINAFY] webhook rejeitado: segredo inválido');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const payload = req.body || {};
    const docId = payload.id || payload.documentId || payload.document_id || null;
    const status = payload.status || payload.event || null;
    const signedUrl = payload.signedPdfUrl || payload.signed_pdf_url || null;

    if (docId) {
      const row = await dbGet(`SELECT * FROM documentos WHERE assinafy_id = ?`, [docId]);
      if (row) {
        const sets = [];
        const params = [];
        if (status) { sets.push(`status = ?`); params.push(String(status)); }
        if (signedUrl) { sets.push(`signed_pdf_public_url = ?`); params.push(signedUrl); sets.push(`signed_at = datetime('now')`); }
        if (sets.length) {
          await dbRun(`UPDATE documentos SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[ASSINAFY] webhook erro:', e);
    res.status(500).json({ error: 'falha ao processar webhook' });
  }
});

module.exports = router;
