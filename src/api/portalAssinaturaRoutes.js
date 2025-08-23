// src/api/portalAssinaturaRoutes.js
// Endpoints usados pelo FRONT do cliente (meus-eventos.html) + rotas públicas utilitárias

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  getDocument,
  getSigningUrl,
  pickBestArtifactUrl,
} = require('../services/assinafyService');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Helpers DB
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

const portalEventosAssinaturaRouter = express.Router();
const documentosAssinafyPublicRouter = express.Router();

// Procura por um link de assinatura dentro de um objeto retornado pelo getDocument
function scanForSigningUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;

  const candidates = [
    obj.sign_url, obj.signer_url, obj.signerUrl, obj.signing_url,
    obj.url, obj.link, obj.signUrl, obj.deep_link, obj.deeplink,
    obj.access_link, obj.public_link,
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
    if (typeof c === 'string' && c.startsWith('/verify/')) {
      return `https://app.assinafy.com.br${c}`;
    }
  }

  if (obj.assignment) {
    const x = scanForSigningUrl(obj.assignment, depth + 1);
    if (x) return x;
  }
  if (Array.isArray(obj.assignments)) {
    for (const it of obj.assignments) {
      const x = scanForSigningUrl(it, depth + 1);
      if (x) return x;
    }
  }

  if (Array.isArray(obj)) {
    for (const it of obj) {
      const found = scanForSigningUrl(it, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const keys = Object.keys(obj);
  for (const k of keys) {
    if (/assign|sign/i.test(k)) {
      const found = scanForSigningUrl(obj[k], depth + 1);
      if (found) return found;
    }
  }
  for (const k of keys) {
    const val = obj[k];
    if (val && typeof val === 'object') {
      const found = scanForSigningUrl(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

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

      let assinaturaUrl = null;
    for (let i = 0; i < 3 && !assinaturaUrl; i++) {
      try {
        const docInfo = await getDocument(row.assinafy_id);
        assinaturaUrl = scanForSigningUrl(docInfo?.data || docInfo);
        if (!assinaturaUrl) await new Promise(r => setTimeout(r, 1000));
      } catch {}
    }

    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, eventoId],
      );
      return res.json({ ok:true, assinatura_url: assinaturaUrl, url: assinaturaUrl, status: 'pendente_assinatura' });
    }

    try {
      const d = await getDocument(row.assinafy_id);
      const st = d?.status;
      if (st === 'certified' || st === 'certificated') {
        return res.json({ ok:true, status:'assinado' });
      }
    } catch {}

    return res.json({ ok:true, pending:true, status: row.status || 'pendente_assinatura' });
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
