// src/services/assinafyClient.js
const axios = require('axios');
const FormData = require('form-data');
const https = require('https');

const DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';

// Tempo maior para upload via CDN
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

// Auth
const API_KEY = process.env.ASSINAFY_API_KEY || '';
const ACCESS_TOKEN = process.env.ASSINAFY_ACCESS_TOKEN || '';

// Base(s)
const ENV_BASE = (process.env.ASSINAFY_API_BASE || '').replace(/\/+$/, '');
const ENV_URL  = (process.env.ASSINAFY_API_URL  || '').replace(/\/+$/, '');

// Conta
const ACCOUNT_ID = process.env.ASSINAFY_ACCOUNT_ID || '';

// Agent sem keep-alive (evita “socket hang up” em alguns CDNs)
const httpsAgent = new https.Agent({
  keepAlive: false,         // <— importante para Cloudflare/ELB instável
  maxSockets: 50
});

function authHeaders() {
  if (API_KEY)      return { 'X-Api-Key': API_KEY };
  if (ACCESS_TOKEN) return { Authorization: `Bearer ${ACCESS_TOKEN}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

// Gera lista de endpoints sensata, na ordem de preferência.
function buildUploadEndpoints() {
  const bases = [];

  if (ENV_BASE) bases.push(ENV_BASE);
  if (ENV_URL)  bases.push(ENV_URL);

  // defaults (prioriza .com.br)
  if (!bases.length) bases.push('https://api.assinafy.com.br');

  // remove duplicadas mantendo a ordem
  const uniqBases = [...new Set(bases)];

  const urls = [];
  for (const b of uniqBases) {
    const hasV1 = /\/v1$/.test(b);
    // 1) v1/accounts/:id/documents
    if (ACCOUNT_ID) {
      if (hasV1) urls.push(`${b}/accounts/${ACCOUNT_ID}/documents`);
      else       urls.push(`${b}/v1/accounts/${ACCOUNT_ID}/documents`);
    }
    // 2) v1/documents
    if (hasV1) urls.push(`${b}/documents`);
    else       urls.push(`${b}/v1/documents`);
  }

  // 3) fallback legado cru
  urls.push('https://api.assinafy.com.br/documents');

  // remove duplicadas mantendo a ordem
  return [...new Set(urls)];
}

async function tryPost(url, form, extraHeaders = {}) {
  const cfg = {
    method: 'POST',
    url,
    data: form,
    timeout: TIMEOUT,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    // Rede
    httpsAgent,
    family: 4,      // força IPv4
    proxy: false,   // ignora HTTP(S)_PROXY do ambiente
    // Headers
    headers: {
      ...form.getHeaders(),
      ...authHeaders(),
      ...extraHeaders
    },
    validateStatus: s => s >= 200 && s < 300
  };
  if (DEBUG) console.log('[ASSINAFY][POST] tentando:', url);
  const resp = await axios(cfg);
  if (DEBUG) console.log('[ASSINAFY][POST] OK:', url);
  return resp.data;
}

async function postMultipartToFirstAlive(form, extraHeaders = {}) {
  const endpoints = buildUploadEndpoints();

  const tries = [];
  for (const url of endpoints) {
    try {
      return await tryPost(url, form, extraHeaders);
    } catch (err) {
      const code   = err.code || err?.response?.status || 'ERR';
      const status = err?.response?.status;
      let msg = err.message || String(err);
      // corta payloads grandes nos logs
      const dataSnippet = err?.response?.data && typeof err.response.data === 'string'
        ? err.response.data.slice(0, 200)
        : (err?.response?.data ? '[json]' : '');

      tries.push({ url, code, status, msg, data: dataSnippet });
      if (DEBUG) {
        console.warn('[ASSINAFY][POST] falhou:', { url, code, status, msg });
      }
      // tenta próximo endpoint
      continue;
    }
  }

  // Se todos falharam, joga erro com resumo de tentativas
  const resume = tries.map(t => `${t.url} (code=${t.code}${t.status ? `, http=${t.status}` : ''})`).join(' | ');
  const error  = new Error(`Falha no envio. Tentativas: ${resume}`);
  if (DEBUG) console.error('[ASSINAFY][POST] todas tentativas falharam:', tries);
  throw error;
}

/**
 * Upload de PDF (Buffer).
 * Extra:
 *   - callbackUrl: seu webhook/status
 *   - demais flags aceitas pela API (opcionais)
 */
async function uploadPdf(pdfBuffer, filename = 'documento.pdf', config = {}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('pdfBuffer inválido.');
  }

  const form = new FormData();
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  const { callbackUrl = process.env.ASSINAFY_CALLBACK_URL, ...flags } = config || {};
  if (callbackUrl) form.append('callbackUrl', callbackUrl);

  // flags como strings
  Object.entries(flags).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    form.append(k, typeof v === 'boolean' ? String(v) : String(v));
  });

  return await postMultipartToFirstAlive(form);
}

/** Consulta status (tenta v1 e legado). */
async function getDocumentStatus(id) {
  if (!id) throw new Error('id é obrigatório.');
  const headers = authHeaders();

  const bases = [];
  if (ENV_BASE) bases.push(ENV_BASE);
  if (ENV_URL)  bases.push(ENV_URL);
  if (!bases.length) bases.push('https://api.assinafy.com.br');

  const urls = [];
  for (const b0 of [...new Set(bases)]) {
    const b = b0.replace(/\/+$/, '');
    const hasV1 = /\/v1$/.test(b);
    if (hasV1) urls.push(`${b}/documents/${id}`);
    else       urls.push(`${b}/v1/documents/${id}`);
  }
  urls.push(`https://api.assinafy.com.br/documents/${id}`);

  let lastErr = null;
  for (const url of [...new Set(urls)]) {
    try {
      if (DEBUG) console.log('[ASSINAFY][GET] tentando:', url);
      const resp = await axios.get(url, { timeout: TIMEOUT, httpsAgent, family: 4, proxy: false, headers });
      if (DEBUG) console.log('[ASSINAFY][GET] OK:', url);
      return resp.data;
    } catch (err) {
      lastErr = err;
      if (DEBUG) console.warn('[ASSINAFY][GET] falhou:', url, err.code || err?.response?.status || err.message);
      continue;
    }
  }
  throw lastErr || new Error('Falha ao consultar documento.');
}

/** Download do PDF assinado (arraybuffer). */
async function downloadSignedPdf(id) {
  if (!id) throw new Error('id é obrigatório.');
  const headers = { ...authHeaders(), Accept: 'application/pdf' };

  const bases = [];
  if (ENV_BASE) bases.push(ENV_BASE);
  if (ENV_URL)  bases.push(ENV_URL);
  if (!bases.length) bases.push('https://api.assinafy.com.br');

  const urls = [];
  for (const b0 of [...new Set(bases)]) {
    const b = b0.replace(/\/+$/, '');
    const hasV1 = /\/v1$/.test(b);
    if (hasV1) urls.push(`${b}/documents/${id}`);
    else       urls.push(`${b}/v1/documents/${id}`);
  }
  urls.push(`https://api.assinafy.com.br/documents/${id}`);

  let lastErr = null;
  for (const url of [...new Set(urls)]) {
    try {
      if (DEBUG) console.log('[ASSINAFY][DL] tentando:', url);
      const resp = await axios.get(url, {
        timeout: TIMEOUT,
        responseType: 'arraybuffer',
        httpsAgent, family: 4, proxy: false,
        headers
      });
      if (DEBUG) console.log('[ASSINAFY][DL] OK:', url);
      return resp.data;
    } catch (err) {
      lastErr = err;
      if (DEBUG) console.warn('[ASSINAFY][DL] falhou:', url, err.code || err?.response?.status || err.message);
      continue;
    }
  }
  throw lastErr || new Error('Falha ao baixar PDF.');
}

module.exports = {
  uploadPdf,
  getDocumentStatus,
  downloadSignedPdf,
};
