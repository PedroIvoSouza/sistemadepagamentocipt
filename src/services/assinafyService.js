// src/services/assinafyService.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE = process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1';
const ACCOUNT_ID = process.env.ASSINAFY_ACCOUNT_ID;

// Status do Assinafy considerados finais (documento processado)
const FINAL_STATUSES = new Set(['available', 'ready', 'waiting_for_assignments']);

function authHeaders() {
  const apiKey = process.env.ASSINAFY_API_KEY;
  const bearer = process.env.ASSINAFY_ACCESS_TOKEN;
  if (apiKey) return { 'X-Api-Key': apiKey }; // recomendado pela doc
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

function assertAccount() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
}

/**
 * Upload de um PDF (a partir de arquivo) -> retorna payload do Assinafy
 * Endpoint: POST /accounts/:account_id/documents (multipart/form-data)
 */
async function uploadDocumentFromFile(filePath, filename) {
  assertAccount();
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: filename || path.basename(filePath),
    contentType: 'application/pdf'
  });

  const resp = await axios.post(
    `${BASE}/accounts/${ACCOUNT_ID}/documents`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
  return resp.data; // contém { id, status, artifacts: { original } }
}

/**
 * Cria um signatário (se precisar).
 * Endpoint: POST /accounts/:account_id/signers
 */
async function createSigner({ full_name, email, government_id, phone }) {
  assertAccount();
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios para o signer.');

  const resp = await axios.post(
    `${BASE}/accounts/${ACCOUNT_ID}/signers`,
    { full_name, email, government_id, telephone: phone },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
  return resp.data; // geralmente { id, full_name, email, ... }
}

/**
 * Busca um signatário pelo e-mail.
 * Endpoint: GET /accounts/:account_id/signers?email=...
 */
async function findSignerByEmail(email) {
  assertAccount();
  const resp = await axios.get(
    `${BASE}/accounts/${ACCOUNT_ID}/signers`,
    { params: { email }, headers: { ...authHeaders() } }
  );
  const arr = Array.isArray(resp.data) ? resp.data : resp.data?.data;
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

/**
 * Garante a existência de um signatário reutilizando por e-mail.
 */
async function ensureSigner({ full_name, email, government_id, phone }) {
  try {
    return await createSigner({ full_name, email, government_id, phone });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || '';
    if (/já existe/i.test(msg) || /already exists/i.test(msg) || err?.response?.status === 400) {
      const found = await findSignerByEmail(email);
      if (found) return found;
    }
    throw err;
  }
}

/**
 * PREPARAR (assignment virtual): dispara a assinatura para um documento já enviado.
 * Endpoint: POST /documents/:documentId/assignments
 * Body: { method: "virtual", signerIds: [ ... ], message?, expires_at? }
 */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  assertAccount();
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) {
    throw new Error('Informe ao menos um signerId.');
  }

  const body = { method: 'virtual', signerIds: signerIds.slice() };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at; // ISO (opcional)

  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.post(url, body, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' }
  });
  return resp.data;
}

/**
 * Consulta um documento no Assinafy (status + artifacts).
 * Endpoint: GET /documents/:documentId
 */
async function getDocument(documentId) {
  assertAccount();
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  return resp.data?.data || resp.data;
}

/**
 * Lista assignments de um documento (para obter a URL de assinatura).
 * Endpoint: GET /documents/:documentId/assignments
 */
async function listAssignments(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  const arr = Array.isArray(resp.data) ? resp.data : resp.data?.data;
  return Array.isArray(arr) ? arr : [];
}

function _pickAssignmentUrl(a) {
  return a?.sign_url || a?.signer_url || a?.signerUrl || a?.signing_url || a?.url || a?.link || null;
}
async function getBestSigningUrl(documentId) {
  const list = await listAssignments(documentId);
  for (const a of list) {
    const link = _pickAssignmentUrl(a);
    if (link && /^https?:\/\//i.test(link)) return link;
  }
  return null;
}

/**
 * (NOVO) Aguarda até ficar pronto para assinar (pending_signature ou certificated)
 */
async function waitForPendingSignature(documentId, { retries = 60, intervalMs = 1500 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const info = await getDocument(documentId);
    const status = info?.status;
    // logs úteis para depuração
    console.log(`Assinafy document ${documentId} status (attempt ${attempt + 1}/${retries}): ${status}`);
    if (status === 'pending_signature' || status === 'certificated') return info;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  const err = new Error('Timeout aguardando pending_signature.');
  err.timeout = true;
  throw err;
}

/**
 * (COMPATÍVEL) "prepareDocument":
 * - Aceita EITHER signerIds OR { full_name, email, government_id?, phone?, message?, expires_at? }
 * - Internamente garante o signatário e cria o assignment virtual
 * - Retorna também a URL de assinatura
 * Uso legado com signerIds:
 *   await prepareDocument(docId, { signerIds: [signerId] })
 * Uso por Nome/Email:
 *   await prepareDocument(docId, { full_name, email })
 */
async function prepareDocument(documentId, opts = {}) {
  if (!documentId) throw new Error('documentId é obrigatório.');

  // Caminho 1: já veio com signerIds
  if (Array.isArray(opts.signerIds) && opts.signerIds.length > 0) {
    await requestSignatures(documentId, opts.signerIds, { message: opts.message, expires_at: opts.expires_at });
  } else if (opts.email && opts.full_name) {
    // Caminho 2: Nome/Email do cliente → garante signatário e usa o id
    const signer = await ensureSigner({
      full_name: opts.full_name,
      email: opts.email,
      government_id: opts.government_id,
      phone: opts.phone
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) throw new Error('Falha ao garantir signatário.');
    await requestSignatures(documentId, [signerId], { message: opts.message, expires_at: opts.expires_at });
  } else {
    throw new Error('prepareDocument: forneça signerIds OU { full_name, email }.');
  }

  // Aguarda documento entrar em pending_signature (ou já assinado)
  await waitForPendingSignature(documentId, { retries: 60, intervalMs: 1500 });

  // Obtém a URL para você embutir/abrir
  const assinaturaUrl = await getBestSigningUrl(documentId);

  return { ok: true, documentId, assinaturaUrl };
}

/**
 * Retorna a melhor URL de download do PDF:
 *  - se existir artifacts.certificated, usa ela (assinado)
 *  - senão, usa artifacts.original (upload)
 */
function pickBestArtifactUrl(documentData) {
  const artifacts = documentData?.artifacts || {};
  return artifacts.certificated || artifacts.original || null;
}

module.exports = {
  uploadDocumentFromFile,
  createSigner,
  ensureSigner,
  requestSignatures,
  getDocument,
  prepareDocument,
  waitForDocumentReady,
  pickBestArtifactUrl,
};
