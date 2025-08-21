// src/services/assinafyClient.js
// Cliente Assinafy com criação idempotente de signatário, assignment (virtual) e utilitários.

const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const DEBUG    = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT  = Number(process.env.ASSINAFY_TIMEOUT_MS || 90_000);

const API_KEY       = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN  = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const ACCOUNT_ID    = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const BASE          = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const INSECURE      = String(process.env.ASSINAFY_INSECURE || '') === '1';

if (!ACCOUNT_ID) {
  console.warn('[ASSINAFY] AVISO: ASSINAFY_ACCOUNT_ID vazio — chamadas que dependem dele irão falhar.');
}

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: !INSECURE,
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function authHeaders() {
  const h = {};
  if (API_KEY) {
    // alguns gateways são sensíveis ao case — mande todas
    h['X-Api-Key'] = API_KEY;
    h['X-API-KEY'] = API_KEY;
    h['x-api-key'] = API_KEY;
  }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
  if (!API_KEY && !ACCESS_TOKEN) {
    throw new Error('Configure ASSINAFY_API_KEY e/ou ASSINAFY_ACCESS_TOKEN.');
  }
  return h;
}

function axJson() {
  return axios.create({
    baseURL: BASE,
    timeout: TIMEOUT,
    httpsAgent,
    headers: { Accept: 'application/json', Connection: 'close', ...authHeaders() },
    validateStatus: () => true,
    maxRedirects: 5,
    proxy: false,
  });
}

function axStream() {
  return axios.create({
    baseURL: BASE,
    timeout: TIMEOUT,
    httpsAgent,
    responseType: 'stream',
    headers: { ...authHeaders() },
    validateStatus: () => true,
    maxRedirects: 5,
    proxy: false,
  });
}

// -----------------------------------------------------------------------------
// Upload de PDF
// -----------------------------------------------------------------------------
async function uploadPdf(pdfBuffer, filename = 'documento.pdf', extra = {}) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) throw new Error('pdfBuffer inválido.');

  const form = new FormData();
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === 'boolean' ? String(v) : String(v));
    }
  }

  const url = `/accounts/${ACCOUNT_ID}/documents`; // criação é por conta
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + url, 'multipart/form-data');

  const resp = await axios.request({
    method: 'POST',
    url: BASE + url,
    data: form,
    headers: { ...form.getHeaders(), ...authHeaders(), Accept: 'application/json', Connection: 'close' },
    timeout: TIMEOUT,
    httpsAgent,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    proxy: false,
    validateStatus: () => true,
  });

  if (resp.status >= 200 && resp.status < 300) return resp.data;

  if (DEBUG) console.warn('[ASSINAFY][POST][uploadPdf] falhou:', resp.status, resp.data);
  if (resp.status === 401) {
    throw new Error(`Falha no envio (401 Unauthorized). Verifique credenciais e a conta ${ACCOUNT_ID}.`);
  }
  throw new Error(`Falha no envio. HTTP ${resp.status}`);
}

// -----------------------------------------------------------------------------
// Documento
// -----------------------------------------------------------------------------
async function getDocument(documentId) {
  const u = `/documents/${encodeURIComponent(documentId)}`;
  const r = await axJson().get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  const err = new Error(`Erro ao obter documento (HTTP ${r.status})`);
  err.response = r;
  throw err;
}

async function getDocumentStatus(id) {
  const u = `/documents/${encodeURIComponent(id)}`;
  const r = await axJson().get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  const err = new Error(`Erro ao obter status do documento (HTTP ${r.status})`);
  err.response = r;
  throw err;
}

// Baixa artefatos do documento (original, certificated, certificate-page, bundle)
async function downloadArtifact(documentId, artifactName = 'certificated') {
  const u = `/documents/${encodeURIComponent(documentId)}/download/${encodeURIComponent(artifactName)}`;
  const r = await axios.request({
    method: 'GET',
    url: BASE + u,
    responseType: 'stream',
    httpsAgent,
    headers: { ...authHeaders(), Accept: 'application/pdf', Connection: 'close' },
    validateStatus: () => true,
    maxRedirects: 5,
    proxy: false,
    timeout: TIMEOUT,
  });
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) {
    const chunks = [];
    for await (const chunk of r.data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const err = new Error(`Erro ao baixar artefato "${artifactName}" (HTTP ${r.status})`);
  err.response = r;
  throw err;
}

async function downloadSignedPdf(id) {
  return downloadArtifact(id, 'certificated'); // nome correto do artefato
}

// -----------------------------------------------------------------------------
// Assignments (preparar documento p/ assinatura SEM CAMPOS = method: "virtual")
// -----------------------------------------------------------------------------
async function listAssignments(documentId) {
  const u = `/documents/${encodeURIComponent(documentId)}/assignments`;
  try {
    const r = await axJson().get(u);
    if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
    if (r.status === 204 || r.status === 404) return [];
    if (r.status >= 200 && r.status < 300) {
      return Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
    }
    return [];
  } catch (e) {
    if (e?.response?.status === 404 || e?.response?.status === 204) return [];
    throw e;
  }
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

async function createAssignment(documentId, signerId, opts = {}) {
  if (!documentId || !signerId) throw new Error('documentId e signerId são obrigatórios.');
  // Endpoint correto para assignments fica sob /documents/:id/assignments
  const u = `/documents/${encodeURIComponent(documentId)}/assignments`;
  const body = { method: 'virtual', signerIds: [signerId], ...opts };

  const r = await axJson().post(u, body);
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + u, r.status);

  if (r.status >= 200 && r.status < 300) return r.data;

  const msg = r.data?.message || r.data?.error || '';
  if (r.status === 400 && /pending_signature/i.test(msg)) {
    const link = await getBestSigningUrl(documentId);
    return { pending: true, email_sent: true, url: link || null };
  }
  if (r.status === 409 || /already.*assignment/i.test(msg)) {
    const link = await getBestSigningUrl(documentId);
    return { reused: true, url: link || null };
  }
  throw new Error(r.data?.message || `Falha ao criar assignment (HTTP ${r.status}).`);
}

// -----------------------------------------------------------------------------
// Signatário
// -----------------------------------------------------------------------------
async function createSigner({ full_name, email, government_id, phone }) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios.');

  const u = `/accounts/${ACCOUNT_ID}/signers`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + u, 'application/json');
  const r = await axJson().post(u, { full_name, email, government_id, telephone: phone });

  if (r.status >= 200 && r.status < 300) return r.data;

  if (DEBUG) console.warn('[ASSINAFY][SIGNER] create falhou:', r.status, r.data || '');
  const message = r.data?.message || r.data?.error || '';
  const err = new Error(message || `Falha ao criar signatário (HTTP ${r.status}).`);
  err.response = r;
  throw err;
}

async function findSignerByEmail(email) {
  const u = `/accounts/${ACCOUNT_ID}/signers?email=${encodeURIComponent(email)}`;
  const r = await axJson().get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) {
    const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
    return arr?.[0] || null;
  }
  return null;
}

async function ensureSigner({ full_name, email, government_id, phone }) {
  try {
    const s = await createSigner({ full_name, email, government_id, phone });
    return s;
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || '';
    if (/já existe/i.test(msg) || /already exists/i.test(msg) || e?.response?.status === 400) {
      const found = await findSignerByEmail(email);
      if (found) return found;
    }
    throw e;
  }
}

// -----------------------------------------------------------------------------
// Fluxo EMBEDDED do signatário (verify, aceitar termos, assinar "virtual")
// -----------------------------------------------------------------------------
async function verifySignerCode({ signer_access_code, verification_code }) {
  const u = `/verify`;
  const body = { 'signer-access-code': signer_access_code, 'verification-code': verification_code };
  const r = await axJson().post(u, body);
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(r.data?.message || `Falha ao verificar código (HTTP ${r.status}).`);
}

async function acceptTerms({ signer_access_code }) {
  const u = `/signers/accept-terms`;
  const body = { 'signer-access-code': signer_access_code };
  const r = await axJson().put(u, body);
  if (DEBUG) console.log('[ASSINAFY][PUT]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(r.data?.message || `Falha ao aceitar termos (HTTP ${r.status}).`);
}

async function signVirtualDocuments(signer_access_code, documentIds) {
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    throw new Error('documentIds deve ser um array com pelo menos 1 id.');
  }
  const u = `/signers/documents/sign-multiple?signer-access-code=${encodeURIComponent(signer_access_code)}`;
  const r = await axJson().put(u, { document_ids: documentIds });
  if (DEBUG) console.log('[ASSINAFY][PUT]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(r.data?.message || `Falha ao assinar documentos (HTTP ${r.status}).`);
}

// -----------------------------------------------------------------------------
// Polling de status
// -----------------------------------------------------------------------------
async function waitForStatus(documentId, isDone, { intervalMs = 2000, maxMs = 120000 } = {}) {
  const start = Date.now();
  while (true) {
    const d = await getDocumentStatus(documentId);
    const status = d?.data?.status || d?.status || d?.data?.data?.status;
    if (DEBUG) console.log('[ASSINAFY][STATUS]', documentId, status);
    if (isDone(status)) return status;
    if (Date.now() - start > maxMs) throw new Error(`Timeout aguardando status; último: ${status}`);
    await sleep(intervalMs);
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
  // upload / documento
  uploadPdf,
  getDocument,
  getDocumentStatus,
  downloadArtifact,
  downloadSignedPdf,

  // assignments
  listAssignments,
  getBestSigningUrl,
  createAssignment,

  // signers
  createSigner,
  findSignerByEmail,
  ensureSigner,

  // embedded flow
  verifySignerCode,
  acceptTerms,
  signVirtualDocuments,

  // helpers
  waitForStatus,
};
