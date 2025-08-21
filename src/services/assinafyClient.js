// src/services/assinafyClient.js
const axios = require('axios');
const FormData = require('form-data');
const https = require('https');

const DEBUG   = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

const API_KEY      = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const ACCOUNT_ID   = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const BASE         = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const INSECURE     = String(process.env.ASSINAFY_INSECURE || '') === '1';

const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: !INSECURE, // permite pular certificado se ASSINAFY_INSECURE=1
});

function authHeaders() {
  const h = {};
  if (API_KEY) {
    // Mandamos todas as variações (alguns gateways tratam case diferente)
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

// Desembrulha payloads no formato {status, message, data}
function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'status' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

function uploadUrl() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  return `${BASE}/accounts/${ACCOUNT_ID}/documents`;
}

async function tryPost(url, data, headersExtra = {}) {
  const headers = {
    Accept: 'application/json',
    Connection: 'close',
    ...authHeaders(),
    ...headersExtra,
  };

  const cfg = {
    method: 'POST',
    url,
    data,
    timeout: TIMEOUT,
    httpsAgent,
    family: 4,
    proxy: false,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers,
    validateStatus: s => s >= 200 && s < 300,
  };

  if (DEBUG) console.log('[ASSINAFY][POST]', url);
  return axios(cfg);
}

async function tryGet(url, headersExtra = {}, opts = {}) {
  const headers = {
    Accept: 'application/json',
    Connection: 'close',
    ...authHeaders(),
    ...headersExtra,
  };
  const cfg = {
    method: 'GET',
    url,
    timeout: TIMEOUT,
    httpsAgent,
    family: 4,
    proxy: false,
    headers,
    validateStatus: s => s >= 200 && s < 300,
    ...opts,
  };
  if (DEBUG) console.log('[ASSINAFY][GET]', url);
  return axios(cfg);
}

async function uploadPdf(pdfBuffer, filename = 'documento.pdf', { callbackUrl = process.env.ASSINAFY_CALLBACK_URL, ...flags } = {}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) throw new Error('pdfBuffer inválido.');

  const form = new FormData();
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });
  if (callbackUrl) form.append('callbackUrl', callbackUrl);
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === 'boolean' ? String(v) : String(v));
  }

  try {
    const resp = await tryPost(uploadUrl(), form, form.getHeaders());
    const data = unwrap(resp.data);
    if (DEBUG) console.log('[ASSINAFY][UPLOAD] OK:', resp.status, data?.id || '');
    return data; // <- já desembrulhado
  } catch (err) {
    const status = err?.response?.status;
    const code   = err?.code;
    if (DEBUG) console.warn('[ASSINAFY][UPLOAD] falhou:', { status, code, body: err?.response?.data });
    if (status === 401) {
      throw new Error(`Falha no envio (401 Unauthorized). Verifique ASSINAFY_API_KEY/ACCESS_TOKEN e se pertencem à conta ${ACCOUNT_ID}.`);
    }
    throw new Error(`Falha no envio. ${status ? `HTTP ${status}` : code || err.message}`);
  }
}

// Normalizadores opcionais
const onlyDigits = s => String(s || '').replace(/\D/g, '');
function normalizeGovId(v) {
  const d = onlyDigits(v);
  if (d.length === 11 || d.length === 14) return d;
  return undefined;
}
function normalizePhone(v) {
  const d = onlyDigits(v);
  if (!d) return undefined;
  // se vier 10/11 dígitos nacionais, prefixa DDI 55
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

// ---- Signers ----
async function createSigner({ full_name, email, government_id, phone }) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios para o signer.');

  const body = {
    full_name,
    email,
    ...(normalizeGovId(government_id) ? { government_id: normalizeGovId(government_id) } : {}),
    ...(normalizePhone(phone) ? { telephone: normalizePhone(phone) } : {}),
  };

  const url = `${BASE}/accounts/${ACCOUNT_ID}/signers`;
  const resp = await tryPost(url, body, { 'Content-Type': 'application/json' });
  return unwrap(resp.data); // <- pode ser { id, ... }
}

// Tenta localizar um signer por e-mail (fallback caso a criação retorne 409/422)
async function findSignerByEmail(email) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  const url = `${BASE}/accounts/${ACCOUNT_ID}/signers?email=${encodeURIComponent(email)}`;
  try {
    const resp = await tryGet(url);
    const data = unwrap(resp.data);
    // pode vir como objeto único, array ou paginação; tentamos extrair id
    if (!data) return null;
    if (data.id) return data;
    if (Array.isArray(data) && data.length) return data[0];
    if (data.items && Array.isArray(data.items) && data.items.length) return data.items[0];
    return null;
  } catch {
    return null;
  }
}

// Garante um signer (cria ou reaproveita existente)
async function ensureSigner({ full_name, email, government_id, phone }) {
  try {
    const s = await createSigner({ full_name, email, government_id, phone });
    if (s?.id) return s;
  } catch (e) {
    const status = e?.response?.status;
    if (DEBUG) console.warn('[ASSINAFY][SIGNER] create falhou:', status || e.code || e.message);
    if (status === 409 || status === 422) {
      const found = await findSignerByEmail(email);
      if (found?.id) return found;
    }
    throw e;
  }
  // se chegou aqui sem id, tenta buscar
  const found = await findSignerByEmail(email);
  if (found?.id) return found;
  throw new Error('Falha ao criar/localizar signatário na Assinafy.');
}

// ---- Assignment (pedido de assinatura) ----
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) throw new Error('Informe ao menos um signerId.');

  const body = { method: 'virtual', signerIds };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at;

  const url = `${BASE}/documents/${documentId}/assignments`;
  const resp = await tryPost(url, body, { 'Content-Type': 'application/json' });
  return unwrap(resp.data);
}

async function getDocumentStatus(id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const resp = await tryGet(url);
  return unwrap(resp.data);
}

async function downloadSignedPdf(id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const resp = await tryGet(url, { Accept: 'application/pdf' }, { responseType: 'arraybuffer' });
  return resp.data;
}

/**
 * Extrai uma URL de assinatura de diferentes formatos
 */
function pickSigningUrl(obj) {
  // Primeiro, se vier embrulhado, desembrulha
  const root = unwrap(obj);
  try {
    const paths = [
      ['assignment', 'signers', 0, 'links', 'sign'],
      ['assignment', 'signers', 0, 'links', 'signing'],
      ['assignment', 'signers', 0, 'signing_url'],
      ['assignment', 'links', 'sign'],
      ['assignment', 'sign_url'],
      ['signers', 0, 'links', 'sign'],
      ['signers', 0, 'signing_url'],
      ['links', 'sign'],
      ['sign_url'],
      ['signUrl'],
      ['signerUrl'],
      ['signingUrl'],
      ['url'],
    ];
    for (const p of paths) {
      let cur = root;
      for (const key of p) cur = cur?.[key];
      if (cur && typeof cur === 'string') return cur;
    }
  } catch {}
  return null;
}

module.exports = {
  uploadPdf,
  createSigner,
  ensureSigner,
  requestSignatures,
  getDocumentStatus,
  downloadSignedPdf,
  pickSigningUrl,
  unwrap,
};
