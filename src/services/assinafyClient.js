// src/services/assinafyClient.js
// Cliente Assinafy (upload/consulta/baixa PDF)
// - Requer: ASSINAFY_API_BASE (ex: https://api.assinafy.com.br/v1)
//           ASSINAFY_ACCOUNT_ID
//           ASSINAFY_API_KEY  (ou ASSINAFY_ACCESS_TOKEN - opcional)
//
// Dicas:
//   - BASE deve terminar com /v1
//   - Use a mesma combinação que funcionou no cURL: X-Api-Key + /accounts/:id/documents
//   - Se estiver no PM2, garanta que o processo lê as variáveis (dotenv ou ecosystem.config.js)

const axios = require('axios');
const FormData = require('form-data');
const https = require('https');

const DEBUG   = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);

const API_KEY      = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const ACCOUNT_ID   = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const BASE         = ((process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').trim()).replace(/\/+$/, '');

// agente HTTPS sem keepAlive para reduzir "socket hang up" em alguns gateways
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

function authHeaders () {
  const h = {};
  // Envia TODAS as variações (há proxies/gateways sensíveis a case)
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

function uploadUrl () {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  return `${BASE}/accounts/${ACCOUNT_ID}/documents`;
}

function mask (s = '') {
  if (!s) return s;
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

async function tryPost (url, form) {
  const headers = {
    Accept: 'application/json',
    Connection: 'close',                  // encerra após request
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
    family: 4,                            // força IPv4
    proxy: false,
    headers,
    validateStatus: s => s >= 200 && s < 300,
  };

  if (DEBUG) {
    console.log('[ASSINAFY][POST] tentando:', url, {
      base: BASE,
      account: ACCOUNT_ID,
      key_len: (API_KEY || '').length,
      auth: ACCESS_TOKEN ? `bearer(${ACCESS_TOKEN.length})` : 'no-bearer'
    });
  }
  return axios(cfg);
}

/**
 * Faz upload de um PDF (buffer) para a Assinafy.
 * Retorna SEMPRE o objeto interno `data` (que contém `id`, `status`, `artifacts`, etc).
 *
 * Exemplo de uso:
 *   const doc = await uploadPdf(buffer, 'termo.pdf');
 *   console.log(doc.id); // <- id do documento na Assinafy
 */
async function uploadPdf (
  pdfBuffer,
  filename = 'documento.pdf',
  { callbackUrl = process.env.ASSINAFY_CALLBACK_URL, ...flags } = {}
) {
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
    // A API costuma responder: { status, message, data: {...documento...} }
    const payload = resp?.data?.data || resp?.data || {};
    if (DEBUG) {
      console.log('[ASSINAFY][POST] OK:', resp.status, 'docId=', payload?.id || '-', 'status=', payload?.status || '-');
    }
    return payload;
  } catch (err) {
    const status = err?.response?.status;
    const code   = err?.code;
    const body   = err?.response?.data;

    if (DEBUG) {
      console.warn('[ASSINAFY][POST] falhou:', {
        url,
        status,
        code,
        body,
        key_len: (API_KEY || '').length,
        token_len: (ACCESS_TOKEN || '').length,
        account: ACCOUNT_ID
      });
    }

    if (status === 401) {
      throw new Error(`Falha no envio (401 Unauthorized). Verifique ASSINAFY_API_KEY/ACCESS_TOKEN e se pertencem à conta ${ACCOUNT_ID}.`);
    }
    if (code === 'ECONNRESET') {
      throw new Error('Falha no envio (ECONNRESET). Tente novamente; ajuste keepAlive/timeout ou verifique a rede.');
    }
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      throw new Error(`Falha no envio (timeout após ${TIMEOUT}ms).`);
    }
    throw new Error(`Falha no envio. ${status ? `HTTP ${status}` : code || err.message}`);
  }
}

/**
 * Consulta status do documento (retorna o `data` interno quando existir).
 */
async function getDocumentStatus (id) {
  if (!id) throw new Error('id é obrigatório.');
  const url = `${BASE}/documents/${id}`;
  const headers = { ...authHeaders(), Accept: 'application/json', Connection: 'close' };
  const resp = await axios.get(url, {
    timeout: TIMEOUT,
    httpsAgent,
    family: 4,
    proxy: false,
    headers,
  });
  return resp?.data?.data || resp?.data;
}

/**
 * Baixa o PDF assinado (se existir); faz fallback para original se o assinado ainda não existir.
 * Retorna um Buffer (arraybuffer).
 */
async function downloadSignedPdf (id) {
  if (!id) throw new Error('id é obrigatório.');
  const common = { timeout: TIMEOUT, responseType: 'arraybuffer', httpsAgent, family: 4, proxy: false };

  // tenta certificado (assinado)
  try {
    const urlCert = `${BASE}/documents/${id}/download/certificated`;
    const headers = { ...authHeaders(), Accept: 'application/pdf', Connection: 'close' };
    const resp = await axios.get(urlCert, { ...common, headers });
    return resp.data;
  } catch (e1) {
    // fallback para original
    const urlOrig = `${BASE}/documents/${id}/download/original`;
    const headers = { ...authHeaders(), Accept: 'application/pdf', Connection: 'close' };
    const resp2 = await axios.get(urlOrig, { ...common, headers });
    return resp2.data;
  }
}

module.exports = {
  uploadPdf,
  getDocumentStatus,
  downloadSignedPdf,
};
