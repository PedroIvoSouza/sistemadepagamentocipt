// src/services/assinafyClient.js
const axios = require('axios');
const FormData = require('form-data');
const https = require('https');

const DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const ACCOUNT_ID = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();

const BASE = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');

const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

function authHeaders() {
  const h = { };
  // mande TODAS as variações — alguns gateways tem bug de case
  if (API_KEY) {
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

async function tryPost(url, form) {
  const headers = {
    Accept: 'application/json',
    Connection: 'close',
    ...form.getHeaders(),
    ...authHeaders(),
  };

  const cfg = {
    method: 'POST',
    url,
    data: form,
    timeout: TIMEOUT,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    httpsAgent,
    family: 4,
    proxy: false,
    headers,
    validateStatus: s => s >= 200 && s < 300,
  };

  if (DEBUG) console.log('[ASSINAFY][POST] tentando:', url);
  return await axios(cfg);
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

  const url = uploadUrl();
  try {
    const resp = await tryPost(url, form);
    if (DEBUG) console.log('[ASSINAFY][POST] OK:', resp.status, resp.data?.id || '');
    return resp.data;
  } catch (err) {
    const status = err?.response?.status;
    const body   = err?.response?.data;
    const code   = err.code;
    if (DEBUG) console.warn('[ASSINAFY][POST] falhou:', { url, status, code, body });

    if (status === 401) {
      throw new Error(`Falha no envio (401 Unauthorized). Verifique ASSINAFY_API_KEY/ACCESS_TOKEN e se pertencem à conta ${ACCOUNT_ID}.`);
    }
    // erro genérico
    throw new Error(`Falha no envio. ${status ? `HTTP ${status}` : code || err.message}`);
  }
}

async function getDocumentStatus(id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const headers = { ...authHeaders(), Accept: 'application/json', Connection: 'close' };
  const resp = await axios.get(url, { timeout: TIMEOUT, httpsAgent, family: 4, proxy: false, headers });
  return resp.data;
}

async function downloadSignedPdf(id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const headers = { ...authHeaders(), Accept: 'application/pdf', Connection: 'close' };
  const resp = await axios.get(url, { timeout: TIMEOUT, responseType: 'arraybuffer', httpsAgent, family: 4, proxy: false, headers });
  return resp.data;
}

module.exports = { uploadPdf, getDocumentStatus, downloadSignedPdf };
