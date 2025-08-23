// src/api/portalAssinaturaRoutes.js
// Endpoints usados pelo FRONT do cliente (meus-eventos.html)
// e um router público mínimo para expor status/artefatos (sem signing URL).

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  getDocument,
  waitUntilPendingSignature,
  pickBestArtifactUrl,
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
 * Retorna metadados do termo para o portal (cliente).
 * Não tenta fabricar link de assinatura (a Assinafy não fornece pela API).
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
      try { assinafy = await getDocument(row.assinafy_id); } catch {}
    }

    const url_visualizacao = row.pdf_public_url || null;
    const bestAssinado = row.signed_pdf_public_url || (assinafy ? pickBestArtifactUrl(assinafy) : null);

    return res.json({
      ok: true,
      documento_id: row.id,
      evento_id: row.evento_id,
      status: row.status || (assinafy?.status || 'gerado'),
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
 * Confirma que o documento está pending_signature e responde que o acesso é via e-mail.
 * (A Assinafy não fornece o signing URL pela API; ver docs.)
 */
portalEventosAssinaturaRouter.post('/:eventoId/termo/assinafy/link', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, status
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );
    if (!row) return res.status(404).json({ ok:false, error:'Termo não encontrado.' });
    if (!row.assinafy_id) return res.status(409).json({ ok:false, error:'Termo ainda não enviado para assinatura.' });

    // Best-effort: garantir pending_signature
    await waitUntilPendingSignature(row.assinafy_id, { retries: 15, intervalMs: 1000 }).catch(() => {});

    // Como a API não expõe o link, retornamos estado e instrução de e-mail
    return res.json({
      ok: true,
      pending: true,
      via_email: true,
      message: 'O convite de assinatura foi enviado por e-mail pela Assinafy. Acesse pelo link recebido.',
      status: 'pendente_assinatura'
    });
  } catch (e) {
    console.error('[portal termo/link POST] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao verificar assinatura.' });
  }
});

/**
 * GET /api/portal/eventos/:eventoId/termo/assinafy/link
 * Apenas confirma status (polling “amigável”).
 */
portalEventosAssinaturaRouter.get('/:eventoId/termo/assinafy/link', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, status, signed_pdf_public_url
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );
    if (!row) return res.status(404).json({ ok:false, error:'Termo não encontrado.' });
    if (!row.assinafy_id) return res.status(409).json({ ok:false, error:'Termo ainda não enviado para assinatura.' });

    try {
      const d = await getDocument(row.assinafy_id);
      const st = d?.status;
      if (st === 'certified' || st === 'certificated') {
        // idealmente, webhook salva signed_pdf_public_url; aqui só devolvemos status
        return res.json({ ok:true, status:'assinado' });
      }
      return res.json({ ok:true, pending:true, status: st || row.status || 'pendente_assinatura' });
    } catch {
      return res.json({ ok:true, pending:true, status: row.status || 'pendente_assinatura' });
    }
  } catch (e) {
    console.error('[portal termo/link GET] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao consultar link de assinatura.' });
  }
});

/**
 * Router público (opcional): status bruto do documento (para debug/observabilidade)
 * GET /api/documentos/assinafy/:documentId/status
 */
documentosAssinafyPublicRouter.get('/documentos/assinafy/:documentId/status', async (req, res) => {
  try {
    const doc = await getDocument(req.params.documentId);
    const urlAssinado = pickBestArtifactUrl(doc);
    res.json({
      ok: true,
      status: doc?.status || doc?.data?.status,
      artifact: urlAssinado || null,
      raw: doc
    });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok:false, error: e.message });
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
