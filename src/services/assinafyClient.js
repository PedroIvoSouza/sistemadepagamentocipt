// src/services/assinafyClient.js
// Cliente Assinafy com criação idempotente de signatário, assignment e utilitários.

const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const DEBUG   = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

const API_KEY     = (process.env.ASSINAFY_API_KEY || '').trim();
the ACCESS_TOKEN= (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const ACCOUNT_ID  = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const BASE        = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const INSECURE    = String(process.env.ASSINAFY_INSECURE || '') === '1';

if (!ACCOUNT_ID) {
  console.warn('[ASSINAFY] AVISO: ASSINAFY_ACCOUNT_ID vazio — chamadas que dependem dele irão falhar.');
}

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: !INSECURE,
});

function authHeaders() {
  const h = {};
  if (API_KEY) {
    // alguns gateways são sensíveis ao case — mande tudo
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

// ------------------------- Upload de PDF -------------------------
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

// ------------------------- Documento -------------------------
async function getDocument(documentId) {
  const u = `/documents/${encodeURIComponent(documentId)}`;
  const r = await axJson().get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) return r.data;
  const err = new Error(`Erro ao obter documento (HTTP ${r.status})`);
  err.response = r;
  throw err;
}

async function listAssignments(documentId) {
  const u = `/documents/${encodeURIComponent(documentId)}/assignments`;
  const r = await axJson().get(u);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + u, r.status);
  if (r.status >= 200 && r.status < 300) {
    // API às vezes retorna array puro; às vezes, {data:[]}
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

// ------------------------- Signatário -------------------------
async function createSigner({ full_name, email, government_id, phone }) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios.');

  const u = `/accounts/${ACCOUNT_ID}/signers`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + u, 'application/json');
  const r = await axJson().post(u, {
    full_name,
    email,
    government_id,
    telephone: phone,
  });

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
      // tenta buscar
      const found = await findSignerByEmail(email);
      if (found) return found;
    }
    throw e;
  }
}

// ------------------------- Assignment -------------------------
async function createAssignment(documentId, signerId, opts = {}) {
  if (!documentId || !signerId) throw new Error('documentId e signerId são obrigatórios.');

  const u = `/documents/${encodeURIComponent(documentId)}/assignments`;
  const bodies = [
    { method: 'virtual', signerIds: [signerId], ...opts },
    { method: 'virtual', signer_ids: [signerId], ...opts },
    { method: 'virtual', signers: [signerId], ...opts },
  ];

  for (const body of bodies) {
    const r = await axJson().post(u, body);
    if (DEBUG) console.log('[ASSINAFY][POST]', BASE + u, r.status);
    if (r.status >= 200 && r.status < 300) return r.data;

    const msg = r.data?.message || '';
    // se já está pendente, tratamos como ok/idempotente
    if (r.status === 400 && /pending_signature/i.test(msg)) {
      const link = await getBestSigningUrl(documentId);
      return { pending: true, email_sent: true, url: link || null };
    }
    // se já existe assignment, tratamos como ok
    if (r.status === 409 || /already.*assignment/i.test(msg)) {
      const link = await getBestSigningUrl(documentId);
      return { reused: true, url: link || null };
    }
  }

  throw new Error('Falha ao criar assignment.');
}

module.exports = {
  uploadPdf,
  getDocument,
  listAssignments,
  getBestSigningUrl,
  createSigner,
  findSignerByEmail,
  ensureSigner,
  createAssignment,
};
