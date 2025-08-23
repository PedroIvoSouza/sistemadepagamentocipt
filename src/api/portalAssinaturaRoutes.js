// src/api/portalAssinaturaRoutes.js
// Endpoints usados pelo FRONT do cliente (meus-eventos.html)

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

const portalEventosAssinaturaRouter = express.Router();

/**
 * GET /api/portal/eventos/:eventoId/termo/meta
 * Retorna metadados do termo para o portal (cliente).
 * Compatível com o front (usa pdf_public_url/url_visualizacao e campos Assinafy).
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

    // tenta enriquecer com status/artefato da Assinafy quando temos assinafy_id
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
      status: row.status || assinafy?.status || 'gerado',
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

    // Se já temos, devolve direto
    if (row.assinatura_url) {
      return res.json({ ok:true, url: row.assinatura_url, status: row.status || 'pendente_assinatura' });
    }

    // Garante que esteja em pending_signature (rápido, best-effort)
    await waitUntilPendingSignature(row.assinafy_id, { retries: 6, intervalMs: 1000 }).catch(()=> {});

    // Extrai URL do payload (campo assignment etc.)
    let assinaturaUrl = await getSigningUrl(row.assinafy_id);

    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, eventoId]
      );
      return res.json({ ok:true, url: assinaturaUrl, status: 'pendente_assinatura' });
    }

    // Se ainda não veio, retorna "pending" para o front fazer polling
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

    // tenta de novo ler do doc
    let assinaturaUrl = await getSigningUrl(row.assinafy_id);
    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, eventoId]
      );
      return res.json({ ok:true, url: assinaturaUrl, status: 'pendente_assinatura' });
    }

    // se já estiver assinado, diga ao front
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

module.exports = {
  portalEventosAssinaturaRouter,
};
