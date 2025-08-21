// src/services/assinafyClient.js
const axios = require('axios');
const FormData = require('form-data');
const https = require('https');

const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 60000); // 60s
const API_KEY = process.env.ASSINAFY_API_KEY || '';
const ACCESS_TOKEN = process.env.ASSINAFY_ACCESS_TOKEN || '';
const ACCOUNT_ID = process.env.ASSINAFY_ACCOUNT_ID || '';

/**
 * Bases aceitas:
 * - ASSINAFY_API_BASE (ex.: https://api.assinafy.com.br/v1)
 * - ASSINAFY_API_URL  (ex.: https://api.assinafy.com.br)
 *
 * Vamos montar uma lista de possíveis endpoints de upload:
 * 1) <base>/accounts/:id/documents           (se houver /v1 e ACCOUNT_ID)
 * 2) <base>/documents                         (se base tiver /v1)
 * 3) <url>/documents                          (legado/compat)
 */
function buildUploadEndpoints() {
  const bases = [];
  if (process.env.ASSINAFY_API_BASE) bases.push(process.env.ASSINAFY_API_BASE.replace(/\/+$/, ''));
  if (process.env.ASSINAFY_API_URL)  bases.push(process.env.ASSINAFY_API_URL.replace(/\/+$/, ''));
  // defaults sensatos (prioriza .com.br)
  if (!bases.length) bases.push('https://api.assinafy.com.br/v1', 'https://api.assinafy.com.br');

  const endpoints = [];
  for (const base of bases) {
    const hasV1 = /\/v1$/.test(base);
    if (hasV1 && ACCOUNT_ID) {
      endpoints.push(`${base}/accounts/${ACCOUNT_ID}/documents`);
    }
    if (hasV1) {
      endpoints.push(`${base}/documents`);
    }
  }

  // fallback “cru”
  endpoints.push('https://api.assinafy.com.br/documents');

  // remove duplicados mantendo ordem
  return [...new Set(endpoints)];
}

function buildAuthHeaders() {
  if (API_KEY) return { 'X-Api-Key': API_KEY };
  if (ACCESS_TOKEN) return { Authorization: `Bearer ${ACCESS_TOKEN}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

const httpsAgent = new https.Agent({ keepAlive: true });

async function postMultipartToFirstAlive(form, extraHeaders = {}) {
  const endpoints = buildUploadEndpoints();
  let lastErr = null;

  for (const url of endpoints) {
    try {
      const resp = await axios.post(url, form, {
        method: 'POST',
        timeout: TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        httpsAgent,
        // força IPv4 (evita intermitências em IPv6/CGNAT)
        family: 4,
        headers: {
          ...form.getHeaders(),
          ...buildAuthHeaders(),
          ...extraHeaders
        },
        // se o servidor retornar 4xx, queremos o erro imediatamente
        validateStatus: (s) => s >= 200 && s < 300
      });
      return resp.data; // sucesso
    } catch (err) {
      lastErr = err;
      // Alguns CDNs respondem 404/405 rápido – seguimos para o próximo endpoint
      // Timeouts/ECONNRESET também fazem a gente tentar o próximo
      continue;
    }
  }

  // Se nenhum endpoint funcionou, propaga o último erro
  throw lastErr || new Error('Falha no envio (nenhum endpoint respondeu).');
}

/**
 * Faz o upload de um PDF (Buffer) ao Assinafy.
 * Campos extras:
 *  - callbackUrl: URL do seu webhook para status
 *  - qualquer flag adicional aceita pela API
 */
async function uploadPdf(pdfBuffer, filename = 'documento.pdf', config = {}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('pdfBuffer inválido.');
  }

  const form = new FormData();
  form.append('file', pdfBuffer, {
    filename,
    contentType: 'application/pdf'
  });

  const {
    callbackUrl = process.env.ASSINAFY_CALLBACK_URL,
    ...flags
  } = config || {};

  if (callbackUrl) {
    form.append('callbackUrl', callbackUrl);
  }

  // envia demais flags como strings
  Object.entries(flags).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    form.append(k, typeof v === 'boolean' ? String(v) : String(v));
  });

  // tenta nas URLs possíveis (accounts/:id/documents -> /v1/documents -> /documents)
  return await postMultipartToFirstAlive(form);
}

/**
 * Consulta status do documento (funciona para v1 e legado).
 */
async function getDocumentStatus(id) {
  if (!id) throw new Error('id é obrigatório.');
  const headers = buildAuthHeaders();
  const bases = [
    process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1',
    process.env.ASSINAFY_API_URL  || 'https://api.assinafy.com.br'
  ].map(b => b.replace(/\/+$/, ''));

  // ordem: v1/documents/:id -> documents/:id
  const urls = [
    `${bases[0]}/documents/${id}`,
    `${bases[1]}/documents/${id}`
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        timeout: TIMEOUT,
        httpsAgent,
        family: 4,
        headers
      });
      return resp.data;
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  throw lastErr || new Error('Falha ao consultar documento.');
}

/**
 * Download do PDF assinado (arraybuffer).
 */
async function downloadSignedPdf(id) {
  if (!id) throw new Error('id é obrigatório.');
  const headers = { ...buildAuthHeaders(), Accept: 'application/pdf' };
  const bases = [
    process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1',
    process.env.ASSINAFY_API_URL  || 'https://api.assinafy.com.br'
  ].map(b => b.replace(/\/+$/, ''));

  const urls = [
    `${bases[0]}/documents/${id}`, // v1
    `${bases[1]}/documents/${id}`  // legado
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        timeout: TIMEOUT,
        responseType: 'arraybuffer',
        httpsAgent,
        family: 4,
        headers
      });
      return resp.data;
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  throw lastErr || new Error('Falha ao baixar PDF.');
}

module.exports = {
  uploadPdf,
  getDocumentStatus,
  downloadSignedPdf
};
