// src/services/assinafyService.js
// Integração Assinafy de alto nível (upload, signers, assignments, status)

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const ACCOUNT_ID = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();

function authHeaders() {
  const apiKey = (process.env.ASSINAFY_API_KEY || '').trim();
  const bearer = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
  if (apiKey) return { 'X-Api-Key': apiKey };
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

function assertAccount() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
}

const READY_STATUSES = new Set([
  'available',
  'ready',
  'metadata_ready',
  'waiting_for_assignments',
  'pending_signature', // já com assignment criado
]);

/**
 * Upload de um PDF (a partir de arquivo) -> payload da Assinafy
 * POST /accounts/:account_id/documents (multipart/form-data)
 */
async function uploadDocumentFromFile(filePath, filename) {
  assertAccount();
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: filename || path.basename(filePath),
    contentType: 'application/pdf',
  });

  const resp = await axios.post(
    `${BASE}/accounts/${ACCOUNT_ID}/documents`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
  return resp.data; // deve conter { id, status, ... }
}

/**
 * Cria um signatário.
 * POST /accounts/:account_id/signers
 */
async function createSigner({ full_name, email, government_id, phone }) {
  assertAccount();
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios para o signer.');

  const resp = await axios.post(
    `${BASE}/accounts/${ACCOUNT_ID}/signers`,
    { full_name, email, government_id, telephone: phone },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

/**
 * Busca signatário por e-mail.
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
 * Garante o signatário reutilizando e-mail.
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
 * Cria assignment (virtual) para um documento.
 * POST /accounts/:accountId/documents/:documentId/assignments
 */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  assertAccount();
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) {
    throw new Error('Informe ao menos um signerId.');
  }

  const body = { method: 'virtual', signerIds };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at;

  const url = `${BASE}/accounts/${ACCOUNT_ID}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.post(
    url,
    body,
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

/**
 * Consulta documento (status + artifacts).
 * GET /documents/:id
 */
async function getDocument(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  return resp.data?.data || resp.data;
}

/**
 * (Opcional) Prepara documento para campos (não usamos no fluxo virtual sem campos).
 * POST /accounts/:accountId/documents/:documentId/prepare
 */
async function prepareDocument(documentId, fields = []) {
  assertAccount();
  const url = `${BASE}/accounts/${ACCOUNT_ID}/documents/${documentId}/prepare`;
  const resp = await axios.post(
    url,
    { fields },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } },
  );
  return resp.data;
}

/**
 * Espera até status "pronto" (qualquer um em READY_STATUSES).
 */
async function waitForDocumentReady(
  documentId,
  { retries = 20, intervalMs = 3000 } = {},
) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const data = await getDocument(documentId);
      const info = data?.data || data;
      const status = info?.status;

      console.log(`Assinafy document ${documentId} status (attempt ${attempt + 1}/${retries}): ${status}`);

      if (status && READY_STATUSES.has(status)) {
        return info;
      }
    } catch (err) {
      const respStatus = err?.response?.status;
      console.log(
        `Assinafy document ${documentId} fetch error (attempt ${attempt + 1}/${retries}): ${respStatus || err.message}`,
      );
      if (respStatus && respStatus !== 404) throw err;
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const err = new Error('Timeout ao aguardar processamento do documento.');
  err.timeout = true;
  throw err;
}

/**
 * Melhor artefato de download:
 *  - certified (assinado) > original (upload)
 */
function pickBestArtifactUrl(documentData) {
  const artifacts = documentData?.artifacts || {};
  return artifacts.certified || artifacts.original || null;
}

/**
 * Lista assignments de um documento.
 * GET /documents/:id/assignments
 */
async function listAssignments(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  return Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
}

function _pickAssignmentUrl(a) {
  return a?.sign_url || a?.signer_url || a?.signerUrl || a?.signing_url || a?.url || a?.link || null;
}

/**
 * Obtém a melhor URL de assinatura para embutir/linkar.
 */
async function getSigningUrl(documentId) {
  const list = await listAssignments(documentId);
  for (const a of list) {
    const link = _pickAssignmentUrl(a);
    if (link && /^https?:\/\//i.test(link)) return link;
  }
  return null;
}

module.exports = {
  uploadDocumentFromFile,
  createSigner,
  findSignerByEmail,
  ensureSigner,
  requestSignatures,
  getDocument,
  prepareDocument,            // mantida (não usamos no fluxo atual)
  waitForDocumentReady,
  pickBestArtifactUrl,
  listAssignments,
  getSigningUrl,
};
