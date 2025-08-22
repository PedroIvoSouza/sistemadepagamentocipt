// src/services/assinafyService.js
// Serviço de alto nível Assinafy: upload, signers, assignments (com fallback), waits e utilitários.

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';
const BASE  = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const ACCOUNT_ID = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

function authHeaders() {
  const h = {};
  const apiKey = (process.env.ASSINAFY_API_KEY || '').trim();
  const bearer = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
  if (apiKey) { h['X-Api-Key'] = apiKey; h['X-API-KEY'] = apiKey; h['x-api-key'] = apiKey; }
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

const http = axios.create({
  baseURL: BASE,
  timeout: TIMEOUT,
  headers: { Accept: 'application/json', Connection: 'close', ...authHeaders() },
  validateStatus: () => true,
  maxRedirects: 5,
  proxy: false,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const onlyDigits = (v='') => String(v).replace(/\D/g,'');

function ensureOk(resp, what='request') {
  if (resp.status >= 200 && resp.status < 300) return resp.data;
  const err = new Error(`${what} failed (HTTP ${resp.status})`);
  err.response = resp;
  throw err;
}

/* -------------------------------- Upload ----------------------------------- */
async function uploadDocumentFromFile(filePath, filename) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: filename || path.basename(filePath),
    contentType: 'application/pdf',
  });
  const url = `/accounts/${ACCOUNT_ID}/documents`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + url, '(multipart)');
  const resp = await axios.post(BASE + url, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
    timeout: TIMEOUT,
    validateStatus: () => true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return ensureOk(resp, 'uploadDocumentFromFile');
}

/* ------------------------------- Document ---------------------------------- */
async function getDocument(documentId) {
  const url = `/documents/${encodeURIComponent(documentId)}`;
  const resp = await http.get(url);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + url, resp.status);
  return ensureOk(resp, 'getDocument');
}

/** Estados “prontos para criar assignment” */
const READY_FOR_ASSIGNMENT = new Set([
  'metadata_ready',     // <- essencial para sair do seu loop
  'available',
  'ready'
]);

/** Estados que indicam documento já esperando assinatura */
const PENDING_SIGNATURE_STATES = new Set([
  'pending_signature',
  'waiting_for_signature',
  'waiting_for_signatures'
]);

/** Estados finais/gerais que também tratamos como “ready o suficiente” */
const GENERIC_READY = new Set([
  ...READY_FOR_ASSIGNMENT,
  'waiting_for_assignments', // ainda sem assignment
  'pending_signature',
  'certified',
  'certificated'
]);

/** Compat: usado em outros pontos — agora mapeia para READY_FOR_ASSIGNMENT */
async function waitForDocumentReady(documentId, { retries=20, intervalMs=3000 } = {}) {
  return waitUntilReadyForAssignment(documentId, { retries, intervalMs });
}

/** 1ª espera: até o arquivo estar processado e pronto para criar assignment */
async function waitUntilReadyForAssignment(documentId, { retries=20, intervalMs=3000 } = {}) {
  for (let i=0;i<retries;i++) {
    const data = await getDocument(documentId);
    const info = data?.data || data;
    const status = info?.status;
    console.log(`Assinafy document ${documentId} status (attempt ${i+1}/${retries}): ${status}`);
    if (status && READY_FOR_ASSIGNMENT.has(status)) return info;
    await sleep(intervalMs);
  }
  const err = new Error('Timeout ao aguardar documento ficar pronto para assignment.');
  err.timeout = true;
  throw err;
}

/** 2ª espera: após criar assignment, aguardar “pending_signature” */
async function waitUntilPendingSignature(documentId, { retries=30, intervalMs=2000 } = {}) {
  for (let i=0;i<retries;i++) {
    const data = await getDocument(documentId);
    const info = data?.data || data;
    const status = info?.status;
    console.log(`Assinafy document ${documentId} status (pending attempt ${i+1}/${retries}): ${status}`);
    if (status && PENDING_SIGNATURE_STATES.has(status)) return info;
    await sleep(intervalMs);
  }
  const err = new Error('Timeout ao aguardar documento ficar pending_signature.');
  err.timeout = true;
  throw err;
}

/* -------------------------------- Signer ----------------------------------- */
async function createSigner({ full_name, email, government_id, phone }) {
  const url = `/accounts/${ACCOUNT_ID}/signers`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + url);
  const resp = await http.post(url, { full_name, email, government_id, telephone: phone });
  return ensureOk(resp, 'createSigner');
}

async function findSignerByEmail(email) {
  const url = `/accounts/${ACCOUNT_ID}/signers`;
  const resp = await http.get(url, { params: { email } });
  const ok = ensureOk(resp, 'findSignerByEmail');
  const arr = Array.isArray(ok) ? ok : ok?.data;
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

async function ensureSigner({ full_name, email, government_id, phone }) {
  try { return await createSigner({ full_name, email, government_id, phone }); }
  catch (e) {
    const msg = e?.response?.data?.message || e?.message || '';
    if (/já existe/i.test(msg) || /already exists/i.test(msg) || e?.response?.status === 400) {
      const found = await findSignerByEmail(email);
      if (found) return found;
    }
    throw e;
  }
}

/* ---------------------------- Assignments c/fallback ------------------------ */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  if (!Array.isArray(signerIds) || !signerIds.length) throw new Error('Informe ao menos um signerId.');

  const body = { method: 'virtual', signerIds };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at;

  // 1) tenta rota GLOBAL
  let url = `/documents/${encodeURIComponent(documentId)}/assignments`;
  if (DEBUG) console.log('[ASSINAFY][POST try#1]', BASE + url, body);
  let resp = await http.post(url, body);

  if (resp.status === 404) {
    // 2) fallback para rota com ACCOUNT
    url = `/accounts/${ACCOUNT_ID}/documents/${encodeURIComponent(documentId)}/assignments`;
    if (DEBUG) console.log('[ASSINAFY][POST try#2]', BASE + url, body);
    resp = await http.post(url, body);
  }

  if (resp.status === 409) {
    if (DEBUG) console.log('[ASSINAFY][assignments] 409 — assignment já existe.');
    return resp.data || { reused: true };
  }

  return ensureOk(resp, 'requestSignatures');
}

async function listAssignments(documentId) {
  let url = `/documents/${encodeURIComponent(documentId)}/assignments`;
  let resp = await http.get(url);
  if (DEBUG) console.log('[ASSINAFY][GET try#1]', BASE + url, resp.status);
  if (resp.status === 404) {
    url = `/accounts/${ACCOUNT_ID}/documents/${encodeURIComponent(documentId)}/assignments`;
    resp = await http.get(url);
    if (DEBUG) console.log('[ASSINAFY][GET try#2]', BASE + url, resp.status);
  }
  const ok = ensureOk(resp, 'listAssignments');
  return Array.isArray(ok) ? ok : (Array.isArray(ok?.data) ? ok.data : []);
}

function pickAssignmentUrl(a) {
  return a?.sign_url || a?.signer_url || a?.signerUrl || a?.signing_url || a?.url || a?.link || null;
}

async function getSigningUrl(documentId) {
  const list = await listAssignments(documentId);
  for (const a of list) {
    const u = pickAssignmentUrl(a);
    if (u && /^https?:\/\//i.test(u)) return u;
  }
  return null;
}

/* -------------------------------- Artifacts -------------------------------- */
function pickBestArtifactUrl(documentData) {
  const d = documentData?.data || documentData;
  const artifacts = d?.artifacts || {};
  return artifacts.certified || artifacts.certificated || artifacts.original || null;
}

module.exports = {
  uploadDocumentFromFile,
  getDocument,

  // waits
  waitForDocumentReady,              // compat
  waitUntilReadyForAssignment,       // novo
  waitUntilPendingSignature,         // novo

  // signers
  createSigner,
  findSignerByEmail,
  ensureSigner,

  // assignments
  requestSignatures,
  listAssignments,
  getSigningUrl,

  // utils
  pickBestArtifactUrl,
  onlyDigits,
};
