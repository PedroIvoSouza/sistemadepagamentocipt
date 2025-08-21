// src/api/webhooksAssinafyRoutes.js
const express = require('express');
const crypto = require('crypto');
const db = require('../database/db');
const {
  getDocument,
  pickBestArtifactUrl,
} = require('../services/assinafyService');

const router = express.Router();

/* ===== helpers sqlite (simples) ===== */
const dbRun = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.run(sql, p, function (err) {
      if (err) {
        console.error('[SQL][RUN][ERRO]', ctx, err.message);
        return reject(err);
      }
      resolve(this);
    });
  });

/* ===== assinatura opcional (HMAC-SHA256) =====
   - Configure ASSINAFY_WEBHOOK_SECRET no .env
   - No index.js (abaixo), salvamos req.rawBody p/ cálculo
   - Se não quiser validar assinatura, mantenha o SECRET vazio */
function isValidSignature(req) {
  const secret = process.env.ASSINAFY_WEBHOOK_SECRET;
  if (!secret) return true; // sem secret -> aceita
  const header =
    req.get('x-assinafy-signature') ||
    req.get('X-Assinafy-Signature') ||
    ''; // nome ilustrativo

  if (!header || !req.rawBody) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(header, 'utf8'),
      Buffer.from(expected, 'utf8')
    );
  } catch {
    return false;
  }
}

/* ===== extratores tolerantes de payload ===== */
function pickDocumentId(payload) {
  return (
    payload?.documentId ||
    payload?.document?.id ||
    payload?.data?.documentId ||
    payload?.data?.id ||
    payload?.resource?.id ||
    null
  );
}
function pickStatus(payload) {
  return (
    payload?.status ||
    payload?.document?.status ||
    payload?.data?.status ||
    null
  );
}
function pickArtifacts(payload) {
  return (
    payload?.document?.artifacts ||
    payload?.data?.artifacts ||
    payload?.artifacts ||
    null
  );
}

/* ===========================================================
   POST /api/webhooks/assinafy
   Recebe eventos do Assinafy, atualiza `documentos`
   =========================================================== */
router.post('/', async (req, res) => {
  try {
    if (!isValidSignature(req)) {
      console.warn('[WEBHOOK] assinatura inválida');
      return res.status(401).json({ ok: false });
    }

    // Quando você habilita o "raw body" (ver patch no index.js),
    // req.body pode vir como Buffer: trate os 2 casos.
    const body =
      Buffer.isBuffer(req.body) && req.body.length
        ? JSON.parse(req.body.toString('utf8'))
        : req.body || {};

    // Tenta achar id/status/artifacts no payload;
    // se vierem incompletos, consulta o documento na API.
    let documentId = pickDocumentId(body);
    let status = pickStatus(body);
    let artifacts = pickArtifacts(body);

    if (!documentId) {
      console.warn('[WEBHOOK] payload sem documentId. Ignorando.', body);
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!status || !artifacts) {
      try {
        const doc = await getDocument(documentId);
        status = status || doc?.status || null;
        artifacts = artifacts || doc?.artifacts || null;
      } catch (e) {
        console.warn('[WEBHOOK] falha ao consultar documento na API:', e.message);
      }
    }

    const bestUrl = pickBestArtifactUrl({ artifacts });
    const assinado = status === 'certificated' || status === 'signed' || status === 'completed';

    // Atualiza a linha correspondente (idempotente)
    await dbRun(
      `UPDATE documentos
         SET status = COALESCE(?, status),
             signed_pdf_public_url = COALESCE(?, signed_pdf_public_url),
             signed_at = CASE
               WHEN ? AND signed_at IS NULL THEN datetime('now')
               ELSE signed_at
             END
       WHERE assinafy_id = ?`,
      [
        assinado ? 'assinado' : status,
        bestUrl || null,
        assinado ? 1 : 0,
        documentId,
      ],
      'webhook/assinafy-update'
    );

    // Dê 200 rápido — o Assinafy só precisa saber que recebemos.
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[WEBHOOK] erro inesperado:', err);
    // Ainda retornar 2xx é comum em webhooks p/ evitar retries em massa,
    // mas aqui sinalizamos 500 pra debugar (ajuste conforme sua política).
    return res.status(500).json({ ok: false });
  }
});

/* (opcional) rota de teste local */
router.get('/_debug/ping', (_req, res) => res.json({ pong: true }));

module.exports = router;
