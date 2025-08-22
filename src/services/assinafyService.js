// src/services/assinafyService.js
// Service de alto nível para integração com a Assinafy (upload, signer, assignment, status, urls)

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const ACCOUNT_ID = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();

if (!ACCOUNT_ID) {
  console.warn('[ASSINAFY] AVISO: ASSINAFY_ACCOUNT_ID vazio — endpoints que precisam de conta irão falhar.');
}

function authHeaders() {
  if (API_KEY) return { 'X-Api-Key': API_KEY };
  if (ACCESS_TOKEN) return { Authorization: `Bearer ${ACCESS_TOKEN}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

function assertAccount() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
}

const FINAL_READY = new Set([
  'metadata_ready',
  'available',
  'ready',
  'waiting_for_assignments',
  'pending_signature',
  'certificated',
  'certified' // às vezes aparece assim
]);

const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------ Upload ------------------------ */
async function uploadDocumentFromFile(filePath, filename) {
  assertAccount();
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Arquivo do PDF não encontrado.');
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
  return resp.data; // normalmente { id, status: 'uploaded', artifacts: { original: ... } }
}

/* ------------------------ Signer ------------------------ */
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

async function findSignerByEmail(email) {
  assertAccount();
  const resp = await axios.get(
    `${BASE}/accounts/${ACCOUNT_ID}/signers`,
    { params: { email }, headers: { ...authHeaders() } }
  );
  const arr = Array.isArray(resp.data) ? resp.data : resp.data?.data;
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

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

/* ------------------------ Document & Status ------------------------ */
async function getDocument(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  return resp.data?.data || resp.data;
}

async function waitForDocumentReady(documentId, { retries = 20, intervalMs = 3000 } = {}) {
  for (let i = 0; i < retries; i++) {
    const info = await getDocument(documentId);
    const st = info?.status;
    console.log(`Assinafy document ${documentId} status (attempt ${i + 1}/${retries}): ${st}`);
    if (st && FINAL_READY.has(String(st))) return info;
    if (i < retries - 1) await sleep(intervalMs);
  }
  const err = new Error('Timeout ao aguardar processamento do documento.');
  err.timeout = true;
  throw err;
}

/* ------------------------ Assignments & Sign URL ------------------------ */
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
  const resp = await axios.post(url, body, { headers: { ...authHeaders(), 'Content-Type': 'application/json' } });
  return resp.data;
}

async function listAssignments(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  const data = Array.isArray(resp.data) ? resp.data : (Array.isArray(resp.data?.data) ? resp.data.data : []);
  return data || [];
}

function _pickAssignmentUrl(a) {
  return a?.sign_url || a?.signer_url || a?.signerUrl || a?.signing_url || a?.url || a?.link || null;
}

async function getSigningUrl(documentId) {
  const list = await listAssignments(documentId);
  for (const a of list) {
    const u = _pickAssignmentUrl(a);
    if (u && /^https?:\/\//i.test(u)) return u;
  }
  return null;
}

/* ------------------------ Artifacts ------------------------ */
function pickBestArtifactUrl(documentData) {
  const artifacts = documentData?.artifacts || {};
  return artifacts.certified || artifacts.certificated || artifacts.original || null;
}

module.exports = {
  uploadDocumentFromFile,

  createSigner,
  findSignerByEmail,
  ensureSigner,

  requestSignatures,

  getDocument,
  waitForDocumentReady,

  listAssignments,
  getSigningUrl,

  pickBestArtifactUrl,

  // helpers
  onlyDigits,
};
