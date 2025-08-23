// src/api/portalAssinaturaRoutes.js
// Endpoints usados pelo FRONT do cliente (meus-eventos.html) e utilidades públicas da Assinafy.

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  getDocument,
  getSigningUrl,
  waitUntilPendingSignature,
  pickBestArtifactUrl,
} = require('../services/assinafyService');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Helpers DB
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

/* ===========================================================================
   Router do Portal (cliente)
   =========================================================================== */
const portalEventosAssinaturaRouter = express.Router();

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

    if (!row) return res.status(404).json({ ok:false, error:'Nenhum termo gerado ainda.' });

    let assinafyDoc = null;
    if (row.assinafy_id) {
      try {
        const d = await getDocument(row.assinafy_id);
        assinafyDoc = d?.data || d;
      } catch {}
    }

    const status = row.status || assinafyDoc?.status || 'gerado';
    const url_visualizacao = row.pdf_public_url || null;
    const bestAssinado = row.signed_pdf_public_url || (assinafyDoc ? pickBestArtifactUrl(assinafyDoc) : null);

    return res.json({
      ok: true,
      documento_id: row.id,
      evento_id: row.evento_id,
      status,
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
 * Tenta obter (ou materializar) a URL de assinatura e persiste em documentos.assinatura_url.
 * NÃO cria signer nem assignment (isso é responsabilidade do admin).
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
      return res.json({ ok:true, url: row.assinatura_url, status: row.status || 'pendente_assinatura' });
    }

    // aumenta a tolerância (algumas contas demoram a gerar o link)
    await waitUntilPendingSignature(row.assinafy_id, { retries: 15, intervalMs: 2000 }).catch(()=> {});

    let assinaturaUrl = await getSigningUrl(row.assinafy_id);

    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, eventoId]
      );
      return res.json({ ok:true, url: assinaturaUrl, status: 'pendente_assinatura' });
    }

    return res.json({
      ok: true,
      pending: true,
      message: 'Convite enviado. Aguardando geração do link de assinatura…',
      status: row.status || 'pendente_assinatura'
    });
  } catch (e) {
    console.error('[portal termo/link POST] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao obter link de assinatura.' });
  }
});

/**
 * GET /api/portal/eventos/:eventoId/termo/assinafy/link
 * Polling do front: tenta retornar a URL (sem efeitos colaterais).
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
      return res.json({ ok:true, url: row.assinatura_url, status: row.status || 'pendente_assinatura' });
    }

    // tenta extrair novamente
    let assinaturaUrl = await getSigningUrl(row.assinafy_id);
    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, eventoId]
      );
      return res.json({ ok:true, url: assinaturaUrl, status: 'pendente_assinatura' });
    }

    try {
      const d = await getDocument(row.assinafy_id);
      const doc = d?.data || d;
      const st = doc?.status;
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

/* ===========================================================================
   Router público para utilidades de Assinafy
   =========================================================================== */
const documentosAssinafyPublicRouter = express.Router();

documentosAssinafyPublicRouter.get('/assinafy/:id/open', async (req, res) => {
  const { id } = req.params;
  try {
    const url = await getSigningUrl(id);
    if (url) return res.redirect(url);

    const d = await getDocument(id);
    const doc = d?.data || d;
    if (doc?.status === 'certified' || doc?.status === 'certificated') {
      return res.json({ ok: true, status: 'assinado' });
    }
    return res.json({ ok: true, status: doc?.status || 'desconhecido' });
  } catch (e) {
    const st = e?.response?.status || 500;
    return res.status(st).json({ ok: false, error: e?.message || 'Falha ao abrir assinatura.' });
  }
});

documentosAssinafyPublicRouter.get('/assinafy/:id/status', async (req, res) => {
  const { id } = req.params;
  try {
    const d = await getDocument(id);
    return res.json({ ok: true, data: d?.data || d });
  } catch (e) {
    const st = e?.response?.status || 500;
    return res.status(st).json({ ok: false, error: e?.message || 'Falha ao consultar status.' });
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
