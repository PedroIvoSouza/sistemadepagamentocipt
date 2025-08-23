// src/api/portalAssinaturaRoutes.js
// Endpoints usados pelo FRONT do cliente (meus-eventos.html) + rotas públicas utilitárias

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  getDocument,
  getSigningUrl,
  pickBestArtifactUrl,
  waitUntilPendingSignature,
} = require('../services/assinafyService');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Helpers DB
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

const portalEventosAssinaturaRouter = express.Router();
const documentosAssinafyPublicRouter = express.Router();


/**
 * GET /api/portal/eventos/:eventoId/termo/meta
 */
portalEventosAssinaturaRouter.get('/:eventoId/termo/meta', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const row = await dbGet(
      `SELECT id, evento_id, tipo, pdf_url, pdf_public_url, signed_pdf_public_url,
              assinafy_id, assinatura_url, status
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );

    if (!row) {
      return res.status(404).json({ ok:false, error:'Nenhum termo gerado ainda.' });
    }

    let assinafy = null;
    if (row.assinafy_id) {
      try {
        assinafy = await getDocument(row.assinafy_id);
      } catch {}
    }

    const url_visualizacao = row.pdf_public_url || null;
    const bestAssinado = row.signed_pdf_public_url || (assinafy ? pickBestArtifactUrl(assinafy) : null);

    return res.json({
      ok: true,
      documento_id: row.id,
      evento_id: row.evento_id,
      status: row.status || (assinafy?.status) || 'gerado',
      pdf_url: row.pdf_url || null,
      pdf_public_url: row.pdf_public_url || null,
      url_visualizacao,
      assinafy_id: row.assinafy_id || null,
      assinatura_url: row.assinatura_url || null,
      signed_pdf_public_url: bestAssinado || null,
    });
  } catch (e) {
    console.error('[portal termo/meta] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao obter metadados.' });
  }
});

/**
 * POST /api/portal/eventos/:eventoId/termo/assinafy/link
 * (mantido para compatibilidade, mas não tenta mais materializar assinatura_url)
 */
portalEventosAssinaturaRouter.post('/:eventoId/termo/assinafy/link', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url, status
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );
    if (!row) return res.status(404).json({ ok:false, error:'Termo não encontrado.' });
    if (!row.assinafy_id) return res.status(409).json({ ok:false, error:'Termo ainda não enviado para assinatura.' });

    if (row.assinatura_url) {
      return res.json({
        ok: true,
        assinatura_url: row.assinatura_url,
        url: row.assinatura_url,
        status: row.status || 'pendente_assinatura',
      });
    }

    return res.json({ ok:true, pending:true, status: row.status || 'pendente_assinatura' });
  } catch (e) {
    console.error('[portal termo/link POST] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao obter link de assinatura.' });
  }
});

/**
 * GET /api/portal/eventos/:eventoId/termo/assinafy/link
 * Consulta e tenta materializar `assinatura_url` quando ausente.
 */
portalEventosAssinaturaRouter.get('/:eventoId/termo/assinafy/link', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url, status, signed_pdf_public_url
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );
    if (!row) return res.status(404).json({ ok:false, error:'Termo não encontrado.' });
    if (!row.assinafy_id) return res.status(409).json({ ok:false, error:'Termo ainda não enviado para assinatura.' });

    if (row.assinatura_url) {
      return res.json({
        ok: true,
        assinatura_url: row.assinatura_url,
        url: row.assinatura_url,
        status: row.status || 'pendente_assinatura',
      });
    }

    const retries = Number(req.query.retries) || 3;
    const intervalMs = Number(req.query.intervalMs || req.query.interval_ms || req.query.interval) || 1500;

    let info;
    try {
      info = await waitUntilPendingSignature(row.assinafy_id, { retries, intervalMs });
    } catch (err) {
      let lastStatus = null;
      try {
        const d = await getDocument(row.assinafy_id);
        lastStatus = d?.status || d?.data?.status || null;
      } catch {}
      console.log(`[portal termo/link GET] timeout aguardando pending_signature (status: ${lastStatus})`);
      if (lastStatus === 'certified' || lastStatus === 'certificated') {
        return res.json({ ok: true, status: 'assinado' });
      }
      return res.json({ ok: true, pending: true, status: lastStatus || row.status || 'pendente_assinatura' });
    }

    let assinaturaUrl = null;
    try {
      assinaturaUrl = await getSigningUrl(row.assinafy_id);
    } catch {}

    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
          [assinaturaUrl, eventoId],
      );
      return res.json({ ok:true, assinatura_url: assinaturaUrl, url: assinaturaUrl, status: 'pendente_assinatura' });
    }

    const st = info?.status;
    if (st === 'certified' || st === 'certificated') {
      return res.json({ ok:true, status:'assinado' });
    }

    console.log(`[portal termo/link GET] assinatura_url indisponível (status: ${st})`);
    return res.json({ ok:true, status: st || row.status || 'pendente_assinatura' });
  } catch (e) {
    console.error('[portal termo/link GET] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao consultar link de assinatura.' });
  }
});

/* ---------- Rotas públicas auxiliares (opcionais) ---------- */

/** Abre (redirect) o link de assinatura direto pelo documentId */
documentosAssinafyPublicRouter.get('/documentos/assinafy/open/:documentId', async (req, res) => {
  const { documentId } = req.params;
  try {
    const url = await getSigningUrl(documentId);
    if (url) return res.redirect(url);
    return res.status(404).json({ ok:false, error:'Link não disponível.' });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'Falha ao obter link.' });
  }
});

/** Status simples */
documentosAssinafyPublicRouter.get('/documentos/assinafy/status/:documentId', async (req, res) => {
  const { documentId } = req.params;
  try {
    const d = await getDocument(documentId);
    return res.json({ ok:true, status: d?.status || d?.data?.status || null, doc: d });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'Falha ao consultar status.' });
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
