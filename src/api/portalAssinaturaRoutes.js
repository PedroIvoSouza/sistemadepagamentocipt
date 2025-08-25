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
    // A consulta ao banco de dados
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url, status
         FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento' -- << CORREÇÃO APLICADA AQUI (era eventoId)
     ORDER BY id DESC LIMIT 1`,
      [eventoId]
    );

    // Adicionando um log para vermos exatamente o que o banco retornou
    console.log('[DEBUG ROTA NOVA] Dados retornados do banco:', row);

    if (!row) return res.status(404).json({ ok:false, error:'Termo não encontrado no banco de dados.' });
    if (!row.assinafy_id) return res.status(409).json({ ok:false, error:'Termo ainda não foi enviado para assinatura.' });

    // 1. Se o documento já foi assinado
    const status_lower = (row.status || '').toLowerCase();
    if (status_lower === 'assinado' || status_lower === 'certificated' || status_lower === 'certified') {
      return res.json({ ok: true, status: 'assinado', message: 'Este documento já foi assinado.' });
    }

    // 2. Se já temos um link de assinatura direto salvo
    if (row.assinatura_url) {
      return res.json({
        ok: true,
        url: row.assinatura_url,
        status: 'pendente_assinatura',
      });
    }

    // 3. Se está pendente mas sem link, retornamos a URL de VERIFICAÇÃO
    if (status_lower === 'pendente_assinatura' || status_lower === 'pending_signature') {
      return res.json({
        ok: true,
        url: 'https://app.assinafy.com.br/verify',
        status: 'aguardando_token',
      });
    }

    // 4. Fallback
    console.log(`[portal termo/link GET] Status inesperado ou em processamento: ${row.status}`);
    return res.json({
      ok: true,
      pending: true,
      status: row.status || 'processando',
      message: 'O documento está sendo processado. Tente novamente em alguns instantes.',
    });

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
/* ===========================================================
   POST /api/portal/consultar-email
   Busca o e-mail de um permissionário ou cliente de evento pelo CNPJ/CPF.
   =========================================================== */
portalEventosAssinaturaRouter.post('/consultar-email', async (req, res) => {
  const { documento } = req.body;
  if (!documento) {
    return res.status(400).json({ ok: false, error: 'Documento (CNPJ/CPF) é obrigatório.' });
  }

  const docLimpo = String(documento).replace(/\D/g, '');

  try {
    // Procura primeiro na tabela de Permissionários (se existir)
    let sql = `SELECT email FROM permissionarios WHERE cnpj = ?`;
    let row = await dbGet(sql, [docLimpo]);

    // Se não encontrar, procura na tabela de Clientes de Eventos
    if (!row) {
      sql = `SELECT email FROM Clientes_Eventos WHERE documento = ?`;
      row = await dbGet(sql, [docLimpo]);
    }

    if (row && row.email) {
      res.json({ ok: true, email: row.email });
    } else {
      res.status(404).json({ ok: false, error: 'Nenhum cadastro encontrado para o documento informado.' });
    }
  } catch (err) {
    console.error('[consultar-email] erro:', err.message);
    res.status(500).json({ ok: false, error: 'Ocorreu um erro interno. Tente novamente mais tarde.' });
  }
});


// A LINHA DE EXPORTAÇÃO CORRETA PARA ESTE ARQUIVO:
module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
