// src/api/portalAssinaturaRoutes.js
// Rotas do PORTAL (cliente) para assinatura do termo via Assinafy
// Exporta: { portalEventosAssinaturaRouter, documentosAssinafyPublicRouter }

const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// Se você tem um middleware de auth do cliente, importe aqui
// const clientAuthMiddleware = require('../middleware/clientAuthMiddleware');

const {
  getDocument,
  getSigningUrl,
  waitUntilPendingSignature, // se quiser aguardar um pouco
} = require('../services/assinafyService');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Helpers DB (promises + log leve)
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

/* -----------------------------------------------------------------------------
  Router do portal do cliente (fica montado em /api/portal/eventos no index.js)
----------------------------------------------------------------------------- */
const portalEventosAssinaturaRouter = express.Router();

// Se tiver auth do cliente, habilite:
// portalEventosAssinaturaRouter.use(clientAuthMiddleware);

/**
 * GET /api/portal/eventos/:eventoId/assinatura-url
 * Retorna a URL de assinatura para o cliente abrir (popup/iframe).
 * Estratégia:
 *  - Lê de documentos.assinatura_url se já existir
 *  - Se não existir, tenta extrair via getSigningUrl(documentId) e salva
 *  - Se mesmo assim não houver, retorna fallback_open para /api/documentos/assinafy/:id/open
 */
portalEventosAssinaturaRouter.get('/:eventoId/assinatura-url', async (req, res) => {
  const { eventoId } = req.params;

  try {
    // Busca o último termo do evento
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url, status
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );

    if (!row) {
      return res.status(404).json({ ok:false, error: 'Nenhum termo encontrado para este evento.' });
    }

    const assinafyId = row.assinafy_id || null;

    // se já temos assinatura_url salva, devolve
    if (row.assinatura_url) {
      return res.json({
        ok: true,
        assinatura_url: row.assinatura_url,
        status: row.status || null,
        assinafy_id: assinafyId,
        fallback_open: assinafyId ? `/api/documentos/assinafy/${assinafyId}/open` : null,
      });
    }

    // se não temos assinatura_url na base
    if (!assinafyId) {
      return res.status(409).json({ ok:false, error: 'Termo ainda não foi enviado para assinatura.' });
    }

    // tenta garantir que o documento esteja pending_signature (rápido)
    try {
      await waitUntilPendingSignature(assinafyId, { retries: 4, intervalMs: 1000 });
    } catch { /* segue mesmo assim */ }

    // tenta extrair a URL do payload do documento e/ou de assignments (com fallback interno)
    let assinaturaUrl = await getSigningUrl(assinafyId);

    // salva se encontrou
    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos
            SET assinatura_url = ?
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, eventoId]
      );
    }

    return res.json({
      ok: true,
      assinatura_url: assinaturaUrl || null,
      assinafy_id: assinafyId,
      status: row.status || null,
      fallback_open: `/api/documentos/assinafy/${assinafyId}/open`
    });
  } catch (err) {
    console.error('[portal/assinatura-url] erro:', err.message);
    return res.status(500).json({ ok:false, error: 'Falha ao obter URL de assinatura.' });
  }
});

/**
 * GET /api/portal/eventos/:eventoId/termo/status
 * Retorna status do termo + algumas flags úteis para o front do cliente.
 */
portalEventosAssinaturaRouter.get('/:eventoId/termo/status', async (req, res) => {
  const { eventoId } = req.params;

  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url, status, signed_pdf_public_url
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );

    if (!row) {
      return res.status(404).json({ ok:false, error: 'Nenhum termo encontrado.' });
    }

    const assinafyId = row.assinafy_id || null;

    return res.json({
      ok: true,
      status: row.status || null,
      assinatura_disponivel: !!row.assinatura_url || !!assinafyId,
      assinatura_url: row.assinatura_url || null,
      assinafy_id: assinafyId,
      has_signed_pdf: !!row.signed_pdf_public_url,
      signed_pdf_public_url: row.signed_pdf_public_url || null,
      fallback_open: assinafyId ? `/api/documentos/assinafy/${assinafyId}/open` : null,
    });
  } catch (err) {
    console.error('[portal/termo/status] erro:', err.message);
    return res.status(500).json({ ok:false, error: 'Falha ao obter status do termo.' });
  }
});

/* -----------------------------------------------------------------------------
  Router público de utilidades de documento (se quiser expor algo público aqui)
  Mantém a exportação para compat com seu index.js
----------------------------------------------------------------------------- */
const documentosAssinafyPublicRouter = express.Router();

// Exemplo de rota pública simples para testar se o doc existe (opcional)
documentosAssinafyPublicRouter.get('/documentos/assinafy/:id/ping', async (req, res) => {
  const id = req.params.id;
  try {
    const d = await getDocument(id);
    return res.json({ ok:true, status: d?.data?.status || d?.status || null });
  } catch (e) {
    return res.status(404).json({ ok:false, error: 'Documento não encontrado.' });
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
