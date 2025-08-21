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
  rejectUnauthorized: !INSECURE, // permitir pular certificado se ASSINAFY_INSECURE=1
});

function authHeaders() {
  const h = { };
  if (API_KEY) {
    // Algumas infra aceita só uma variação, outras qualquer. Mandamos todas.
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
    if (DEBUG) console.log('[ASSINAFY][UPLOAD] OK:', resp.status, resp.data?.id || '');
    return resp.data; // { id, status, artifacts, ... }
  } catch (err) {
    const status = err?.response?.status;
    const code   = err.code;
    if (DEBUG) console.warn('[ASSINAFY][UPLOAD] falhou:', { status, code, body: err?.response?.data });
    if (status === 401) {
      throw new Error(`Falha no envio (401 Unauthorized). Verifique ASSINAFY_API_KEY/ACCESS_TOKEN e se pertencem à conta ${ACCOUNT_ID}.`);
    }
    throw new Error(`Falha no envio. ${status ? `HTTP ${status}` : code || err.message}`);
  }
}

// ---- Signers ----
async function createSigner({ full_name, email, government_id, phone }) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios para o signer.');

  const body = {
    full_name,
    email,
    // Alguns ambientes usam "government_id" (CPF/CNPJ) e "telephone" (E164 ou nacional)
    ...(government_id ? { government_id } : {}),
    ...(phone ? { telephone: phone } : {}),
  };

  const url = `${BASE}/accounts/${ACCOUNT_ID}/signers`;
  const resp = await tryPost(url, body, { 'Content-Type': 'application/json' });
  return resp.data; // esperado: { id, full_name, email, ... }
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
  return resp.data; // muitas APIs retornam dados do assignment (ou nada além de 200)
}

async function getDocumentStatus(id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const resp = await axios.get(url, {
    headers: { ...authHeaders(), Accept: 'application/json', Connection: 'close' },
    timeout: TIMEOUT,
    httpsAgent,
    family: 4,
    proxy: false,
    validateStatus: s => s >= 200 && s < 300,
  });
  return resp.data;
}

async function downloadSignedPdf(id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const resp = await axios.get(url, {
    headers: { ...authHeaders(), Accept: 'application/pdf', Connection: 'close' },
    responseType: 'arraybuffer',
    timeout: TIMEOUT,
    httpsAgent,
    family: 4,
    proxy: false,
    validateStatus: s => s >= 200 && s < 300,
  });
  return resp.data;
}

/**
 * Tenta extrair uma URL de assinatura de diferentes formatos de payload
 * - alguns retornam em assignment.signers[0].links.sign
 * - outros em assignment.signers[0].signing_url
 * - outros via document.assignment.*
 */
function pickSigningUrl(obj) {
  try {
    const paths = [
      // assignment direto
      ['assignment', 'signers', 0, 'links', 'sign'],
      ['assignment', 'signers', 0, 'links', 'signing'],
      ['assignment', 'signers', 0, 'signing_url'],
      ['assignment', 'links', 'sign'],
      ['assignment', 'sign_url'],
      // via document
      ['signers', 0, 'links', 'sign'],
      ['signers', 0, 'signing_url'],
      ['links', 'sign'],
      ['sign_url'],
      // raiz
      ['signUrl'],
      ['signerUrl'],
      ['signingUrl'],
      ['url'],
    ];
    for (const p of paths) {
      let cur = obj;
      for (const key of p) cur = cur?.[key];
      if (cur && typeof cur === 'string') return cur;
    }
  } catch {}
  return null;
}

module.exports = {
  uploadPdf,
  createSigner,
  requestSignatures,
  getDocumentStatus,
  downloadSignedPdf,
  pickSigningUrl,
};
