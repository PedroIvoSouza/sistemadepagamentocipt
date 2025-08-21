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
const ASSIGN_METHOD = (process.env.ASSINAFY_ASSIGN_METHOD || 'virtual').trim();

const httpsAgent = new https.Agent({
  keepAlive: false,
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
  if (!API_KEY && !ACCESS_TOKEN) {
    throw new Error('Configure ASSINAFY_API_KEY e/ou ASSINAFY_ACCESS_TOKEN.');
  }
  return h;
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'status' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

async function tryPost(url, data, headersExtra = {}) {
  const headers = {
    Accept: 'application/json',
    Connection: 'close',
    ...authHeaders(),
    ...headersExtra,
  };
  const cfg = {
    method: 'POST', url, data, timeout: TIMEOUT,
    httpsAgent, family: 4, proxy: false,
    maxBodyLength: Infinity, maxContentLength: Infinity,
    headers, validateStatus: s => s >= 200 && s < 300,
  };
  if (DEBUG) console.log('[ASSINAFY][POST]', url, headersExtra?.['Content-Type'] || 'multipart/form-data');
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
    method: 'GET', url, timeout: TIMEOUT,
    httpsAgent, family: 4, proxy: false,
    headers, validateStatus: s => s >= 200 && s < 300,
    ...opts,
  };
  if (DEBUG) console.log('[ASSINAFY][GET]', url);
  return axios(cfg);
}

// ----------------------- Upload -----------------------
function uploadUrl() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  return `${BASE}/accounts/${ACCOUNT_ID}/documents`;
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
    return data;
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

// ----------------------- Signers -----------------------
const onlyDigits = s => String(s || '').replace(/\D/g, '');
const normalizeGovId = v => { const d = onlyDigits(v); return (d.length===11 || d.length===14) ? d : undefined; };
const normalizePhone = v => { const d = onlyDigits(v); if (!d) return undefined; return (d.length===10||d.length===11) ? `55${d}` : d; };

async function createSignerRaw(body) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  const url = `${BASE}/accounts/${ACCOUNT_ID}/signers`;
  const resp = await tryPost(url, body, { 'Content-Type': 'application/json' });
  return unwrap(resp.data);
}

async function createSigner({ full_name, email, government_id, phone }) {
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios para o signer.');
  const bodyFull = {
    full_name,
    email,
    ...(normalizeGovId(government_id) ? { government_id: normalizeGovId(government_id) } : {}),
    ...(normalizePhone(phone) ? { telephone: normalizePhone(phone) } : {}),
  };
  try {
    return await createSignerRaw(bodyFull);
  } catch (e) {
    const st = e?.response?.status;
    if (DEBUG) console.warn('[ASSINAFY][SIGNER] create c/ corpo completo falhou:', st, e?.response?.data || e?.message);
    if (st === 400 || st === 409 || st === 422) return await createSignerRaw({ full_name, email });
    throw e;
  }
}

async function findSignerByEmail(email) {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
  const url = `${BASE}/accounts/${ACCOUNT_ID}/signers?email=${encodeURIComponent(email)}`;
  try {
    const resp = await tryGet(url);
    const data = unwrap(resp.data);
    if (data?.id) return data;
    if (Array.isArray(data) && data.length) return data[0];
    if (data?.items && Array.isArray(data.items) && data.items.length) return data.items[0];
    return null;
  } catch { return null; }
}

async function ensureSigner({ full_name, email, government_id, phone }) {
  try {
    const s = await createSigner({ full_name, email, government_id, phone });
    if (s?.id) return s;
  } catch (e) {
    const st = e?.response?.status;
    if (DEBUG) console.warn('[ASSINAFY][SIGNER] create falhou:', st || e.code || e.message, e?.response?.data || '');
    if (st === 409 || st === 422 || st === 400) {
      const found = await findSignerByEmail(email);
      if (found?.id) return found;
    }
    throw e;
  }
  const found = await findSignerByEmail(email);
  if (found?.id) return found;
  throw new Error('Falha ao criar/localizar signatário na Assinafy.');
}

// ----------------------- Assignments -----------------------
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) throw new Error('Informe ao menos um signerId.');
  const base = {};
  if (message) base.message = message;
  if (expires_at) base.expires_at = expires_at;
  const bodies = [
    { method: ASSIGN_METHOD, signerIds,                     ...base },
    { method: ASSIGN_METHOD, signer_ids: signerIds,         ...base },
    { method: ASSIGN_METHOD, signers: signerIds.map(id=>({ id })), ...base },
  ];
  const url = `${BASE}/documents/${documentId}/assignments`;
  let lastErr;
  for (const body of bodies) {
    try {
      const resp = await tryPost(url, body, { 'Content-Type': 'application/json' });
      return unwrap(resp.data);
    } catch (e) {
      lastErr = e;
      const st = e?.response?.status;
      if (DEBUG) console.warn('[ASSINAFY][ASSIGN] tentativa falhou:', st, body.signerIds ? 'signerIds' : (body.signer_ids ? 'signer_ids' : 'signers[]'), e?.response?.data || e?.message);
      if (st && st >= 500) break;
    }
  }
  const st = lastErr?.response?.status;
  const msg = lastErr?.response?.data?.message || lastErr?.message || 'Falha ao criar assignment.';
  const det = lastErr?.response?.data && typeof lastErr.response.data === 'object' ? JSON.stringify(lastErr.response.data) : '';
  throw new Error(`Falha ao criar assignment (HTTP ${st || '??'}). ${msg}${det ? ` | ${det}` : ''}`);
}

async function listAssignments(documentId) {
  const url = `${BASE}/documents/${documentId}/assignments`;
  const resp = await tryGet(url);
  return unwrap(resp.data);
}

// ----------------------- Documentos -----------------------
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

// ----------------------- Extração de links -----------------------
function pickSigningUrl(obj) {
  const root = unwrap(obj);
  const tryObj = (o) => {
    const paths = [
      ['assignment','signers',0,'links','sign'],
      ['assignment','signers',0,'links','signing'],
      ['assignment','signers',0,'signing_url'],
      ['assignment','links','sign'],
      ['assignment','links','signing'],
      ['assignment','sign_url'],
      ['links','sign'],
      ['links','signing'],
      ['sign_url'],
      ['signUrl'],
      ['signerUrl'],
      ['signingUrl'],
      ['url'],
    ];
    for (const p of paths) {
      let cur = o;
      for (const key of p) cur = cur?.[key];
      if (cur && typeof cur === 'string') return cur;
    }
    return null;
  };

  // direto
  const direct = tryObj(root);
  if (direct) return direct;

  // arrays / items
  if (Array.isArray(root)) {
    for (const it of root) {
      const u = tryObj(it);
      if (u) return u;
      if (it?.signers && Array.isArray(it.signers)) {
        for (const s of it.signers) {
          const u2 = tryObj(s);
          if (u2) return u2;
        }
      }
    }
  }
  if (root?.items && Array.isArray(root.items)) {
    for (const it of root.items) {
      const u = tryObj(it);
      if (u) return u;
    }
  }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pollSigningUrl(documentId, { attempts = 6, delayMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      // 1) tenta no documento
      const doc = await getDocumentStatus(documentId).catch(()=>null);
      let url = pickSigningUrl(doc);
      if (url) return url;

      // 2) tenta na listagem de assignments
      const assigns = await listAssignments(documentId).catch(()=>null);
      url = pickSigningUrl(assigns);
      if (url) return url;
    } catch (_) {}
    await sleep(delayMs);
  }
  return null;
}

module.exports = {
  uploadPdf,
  createSigner,
  ensureSigner,
  requestSignatures,
  listAssignments,
  getDocumentStatus,
  downloadSignedPdf,
  pickSigningUrl,
  pollSigningUrl,
  unwrap,
};
