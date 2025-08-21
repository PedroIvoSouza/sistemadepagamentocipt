// src/services/assinafyService.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE = process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1';
const ACCOUNT_ID = process.env.ASSINAFY_ACCOUNT_ID;

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
  return resp.data; // contém id, status=uploaded e artifacts.original
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
  return resp.data; // geralmente retorna { id, full_name, email, ... }
}

/**
 * Busca um signatário pelo e-mail.
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
 * Dispara a assinatura (virtual) para um documento já enviado.
 * Endpoint: POST /documents/:documentId/assignments
 * Body: { method: "virtual", signerIds: [ ... ] }
 */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) {
    throw new Error('Informe ao menos um signerId.');
  }

  const body = { method: 'virtual', signerIds };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at; // ISO (opcional)

  const resp = await axios.post(
    `${BASE}/documents/${documentId}/assignments`,
    body,
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

/**
 * Consulta um documento no Assinafy (status + artifacts).
 */
async function getDocument(documentId) {
  const resp = await axios.get(
    `${BASE}/documents/${documentId}`,
    { headers: { ...authHeaders() } }
  );
  return resp.data;
}

/**
 * Retorna a melhor URL de download do PDF:
 *  - se existir artifacts.certified, usa ela (assinado)
 *  - senão, usa artifacts.original (upload)
 */
function pickBestArtifactUrl(documentData) {
  const artifacts = documentData?.artifacts || {};
  return artifacts.certified || artifacts.original || null;
}

module.exports = {
  uploadDocumentFromFile,
  createSigner,
  ensureSigner,
  requestSignatures,
  getDocument,
  pickBestArtifactUrl,
};
