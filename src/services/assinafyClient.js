// src/services/assinafyClient.js
// Cliente Assinafy com upload, signers e assignments (com fallback de rota) + utilitários.

const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const DEBUG   = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

const API_KEY      = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const ACCOUNT_ID   = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const BASE         = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const INSECURE     = String(process.env.ASSINAFY_INSECURE || '') === '1';

if (!ACCOUNT_ID) console.warn('[ASSINAFY] AVISO: ASSINAFY_ACCOUNT_ID vazio.');
if (!API_KEY && !ACCESS_TOKEN) console.warn('[ASSINAFY] AVISO: configure ASSINAFY_API_KEY e/ou ASSINAFY_ACCESS_TOKEN.');

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: !INSECURE,
});

function authHeaders() {
  const h = {};
  if (API_KEY) {
    h['X-Api-Key'] = API_KEY;
    h['X-API-KEY'] = API_KEY;
    h['x-api-key'] = API_KEY;
  }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
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

const http = axJson();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------- Upload de PDF ------------------------- */
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
  const url = `/accounts/${ACCOUNT_ID}/documents`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + url, '(multipart/form-data)');

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
  if (resp.status === 401) throw new Error(`Falha no envio (401 Unauthorized).`);
  throw new Error(`Falha no envio. HTTP ${resp.status}`);
}

/* ------------------------- Documento ------------------------- */
async function getDocument(documentId) {
  const u = `/documents/${encodeURIComponent(documentId)}`;
  const r = await http.get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  const err = new Error(`Erro ao obter documento (HTTP ${r.status})`);
  err.response = r;
  throw err;
}

async function getDocumentStatus(id) {
  return getDocument(id);
}

async function downloadSignedPdf(id) {
  // nome do artefato varia entre 'certified' e 'certificated'; a URL oficial exposta costuma ser /artifacts/certified
  const u = `/documents/${encodeURIComponent(id)}/artifacts/certified`;
  const r = await axStream().get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) {
    const chunks = [];
    for await (const chunk of r.data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const err = new Error(`Erro ao baixar artefato (HTTP ${r.status})`);
  err.response = r;
  throw err;
}

/* ------------------------- Assignments (com fallback) ------------------------- */
async function _postAssignmentWithFallback(documentId, body) {
  // 1) tenta rota com account (mais segura para seu tenant)
  let u = `/accounts/${ACCOUNT_ID}/documents/${encodeURIComponent(documentId)}/assignments`;
  if (DEBUG) console.log('[ASSINAFY][POST try#1]', BASE + u, JSON.stringify(body));
  let r = await http.post(u, body);
  if (r.status === 404) {
    // 2) cai para rota global
    u = `/documents/${encodeURIComponent(documentId)}/assignments`;
    if (DEBUG) console.log('[ASSINAFY][POST try#2]', BASE + u, JSON.stringify(body));
    r = await http.post(u, body);
  }
  return r;
}

async function createAssignment(documentId, signerId, opts = {}) {
  if (!documentId || !signerId) throw new Error('documentId e signerId são obrigatórios.');
  const body = { method: 'virtual', signerIds: [signerId], ...opts };

  const r = await _postAssignmentWithFallback(documentId, body);

  if (r.status >= 200 && r.status < 300) return r.data;

  const msg = r.data?.message || r.data?.error || '';
  if (r.status === 400 && /pending_signature|metadata_processing/i.test(msg)) {
    const link = await getBestSigningUrl(documentId);
    return { pending: true, email_sent: true, url: link || null };
  }
  if (r.status === 409 || /already.*assignment/i.test(msg)) {
    const link = await getBestSigningUrl(documentId);
    return { reused: true, url: link || null };
  }

  if (DEBUG) console.warn('[ASSINAFY][assignments] falhou:', r.status, r.data);
  throw new Error(r.data?.message || `Falha ao criar assignment (HTTP ${r.status}).`);
}

async function listAssignments(documentId) {
  // também com fallback
  let u = `/accounts/${ACCOUNT_ID}/documents/${encodeURIComponent(documentId)}/assignments`;
  let r = await http.get(u);
  if (DEBUG) console.log('[ASSINAFY][GET try#1]', BASE + u, r.status);
  if (r.status === 404) {
    u = `/documents/${encodeURIComponent(documentId)}/assignments`;
    r = await http.get(u);
    if (DEBUG) console.log('[ASSINAFY][GET try#2]', BASE + u, r.status);
  }
  if (r.status === 204 || r.status === 404) return [];
  if (r.status >= 200 && r.status < 300) {
    return Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
  }
  return [];
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

/* ------------------------- Signatário ------------------------- */
async function createSigner({ full_name, email, government_id, phone }) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  const u = `/accounts/${ACCOUNT_ID}/signers`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + u);
  const r = await http.post(u, { full_name, email, government_id, telephone: phone });
  if (r.status >= 200 && r.status < 300) return r.data;
  const message = r.data?.message || r.data?.error || '';
  const err = new Error(message || `Falha ao criar signatário (HTTP ${r.status}).`);
  err.response = r;
  throw err;
}

async function findSignerByEmail(email) {
  const u = `/accounts/${ACCOUNT_ID}/signers?email=${encodeURIComponent(email)}`;
  const r = await http.get(u);
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

/* ------------------------- Polling de status ------------------------- */
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

async function getStatusPlain(documentId) {
  const d = await getDocumentStatus(documentId);
  return d?.data?.status || d?.status || d?.data?.data?.status || null;
}

async function safeDownloadCertificatedOrNull(documentId) {
  const s = await getStatusPlain(documentId);
  if (s !== 'certificated' && s !== 'certified') {
    if (DEBUG) console.log('[ASSINAFY] safeDownload: status=', s, '— não vou baixar.');
    return null;
  }
  return downloadSignedPdf(documentId);
}

/* ------------------------- Exports ------------------------- */
module.exports = {
  // upload / documento
  uploadPdf,
  getDocument,
  getDocumentStatus,
  downloadSignedPdf,

  // assignments
  listAssignments,
  getBestSigningUrl,
  createAssignment,

  // signers
  createSigner,
  findSignerByEmail,
  ensureSigner,

  // helpers
  waitForStatus,
  getStatusPlain,
  safeDownloadCertificatedOrNull,
};
