// src/services/assinafyService.js
// Serviço Assinafy: upload, signers, assignments (com fallback), waits e utilitários.

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { scanForSigningUrl } = require('./assinafyUtils');

const DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';
const BASE  = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const ACCOUNT_ID = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');

function authHeaders() {
  const h = {};
  const apiKey = (process.env.ASSINAFY_API_KEY || '').trim();
  const bearer = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
  if (apiKey) { h['X-Api-Key'] = apiKey; h['X-API-KEY'] = apiKey; h['x-api-key'] = apiKey; }
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

const http = axios.create({
  baseURL: BASE,
  timeout: TIMEOUT,
  headers: { Accept: 'application/json', Connection: 'close', ...authHeaders() },
  validateStatus: () => true,
  maxRedirects: 5,
  proxy: false,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const onlyDigits = (v='') => String(v).replace(/\D/g,'');

function ensureOk(resp, what='request') {
  if (resp.status >= 200 && resp.status < 300) return resp.data;
  const err = new Error(`${what} failed (HTTP ${resp.status})`);
  err.response = resp;
  throw err;
}

/* -------------------------------- Upload ----------------------------------- */
async function uploadDocumentFromFile(filePath, filename) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: filename || path.basename(filePath),
    contentType: 'application/pdf',
  });
  const url = `/accounts/${ACCOUNT_ID}/documents`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + url, '(multipart)');
  const resp = await axios.post(BASE + url, form, {
    headers: { ...authHeaders(), ...form.getHeaders() },
    timeout: TIMEOUT,
    validateStatus: () => true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return ensureOk(resp, 'uploadDocumentFromFile');
}

/* ------------------------------- Document ---------------------------------- */
async function getDocument(documentId) {
  const url = `/documents/${encodeURIComponent(documentId)}`;
  const resp = await http.get(url);
  if (DEBUG) console.log('[ASSINAFY][GET]', BASE + url, resp.status);
  return ensureOk(resp, 'getDocument');
}

const READY_FOR_ASSIGNMENT = new Set(['metadata_ready','available','ready']);
const PENDING_SIGNATURE_STATES = new Set(['pending_signature','waiting_for_signature','waiting_for_signatures']);
const GENERIC_READY = new Set([...READY_FOR_ASSIGNMENT,'waiting_for_assignments','pending_signature','certified','certificated']);

async function waitForDocumentReady(documentId, { retries=20, intervalMs=3000 } = {}) {
  return waitUntilReadyForAssignment(documentId, { retries, intervalMs });
}
async function waitUntilReadyForAssignment(documentId, { retries=20, intervalMs=3000 } = {}) {
  for (let i=0;i<retries;i++) {
    const data = await getDocument(documentId);
    const info = data?.data || data;
    const status = info?.status;
    console.log(`Assinafy document ${documentId} status (attempt ${i+1}/${retries}): ${status}`);
    if (status && READY_FOR_ASSIGNMENT.has(status)) return info;
    await sleep(intervalMs);
  }
  const err = new Error('Timeout ao aguardar documento ficar pronto para assignment.');
  err.timeout = true;
  throw err;
}
async function waitUntilPendingSignature(documentId, { retries=30, intervalMs=2000 } = {}) {
  for (let i=0;i<retries;i++) {
    const data = await getDocument(documentId);
    const info = data?.data || data;
    const status = info?.status;
    console.log(`Assinafy document ${documentId} status (pending attempt ${i+1}/${retries}): ${status}`);
    if (status && PENDING_SIGNATURE_STATES.has(status)) return info;
    await sleep(intervalMs);
  }
  const err = new Error('Timeout ao aguardar documento ficar pending_signature.');
  err.timeout = true;
  throw err;
}

/* -------------------------------- Signer ----------------------------------- */
async function createSigner({ full_name, email, government_id, phone }) {
  const url = `/accounts/${ACCOUNT_ID}/signers`;
  if (DEBUG) console.log('[ASSINAFY][POST]', BASE + url);
  const resp = await http.post(url, { full_name, email, government_id, telephone: phone });
  return ensureOk(resp, 'createSigner');
}
async function findSignerByEmail(email) {
  const url = `/accounts/${ACCOUNT_ID}/signers`;
  const resp = await http.get(url, { params: { email } });
  const ok = ensureOk(resp, 'findSignerByEmail');
  const arr = Array.isArray(ok) ? ok : ok?.data;
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}
async function findSignerByGovernmentId(government_id) {
  const url = `/accounts/${ACCOUNT_ID}/signers`;
  const resp = await http.get(url, { params: { government_id } });
  const ok = ensureOk(resp, 'findSignerByGovernmentId');
  const arr = Array.isArray(ok) ? ok : ok?.data;
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}
async function updateSignerEmail(id, email, phone) {
  const url = `/accounts/${ACCOUNT_ID}/signers/${encodeURIComponent(id)}`;
  const payload = {};
  if (email !== undefined) payload.email = email;
  if (phone) payload.telephone = phone;
  if (DEBUG) console.log('[ASSINAFY][PUT]', BASE + url, payload);
  const resp = await http.put(url, payload);
  return ensureOk(resp, 'updateSignerEmail');
}
async function ensureSigner({ full_name, email, government_id, phone }) {
  try {
    return await createSigner({ full_name, email, government_id, phone });
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || '';
    if (/já existe/i.test(msg) || /already exists/i.test(msg) || e?.response?.status === 400) {
      let found = await findSignerByEmail(email);
      if (!found && government_id) {
        found = await findSignerByGovernmentId(government_id);
      }
      if (found) {
        const domain = found.email?.split('@')[1]?.toLowerCase();
        const normalizedEmail = (email || '').trim();
        const normalizedPhone = (phone || '').trim();
        const foundEmail = (found.email || '').trim();
        const emailsDiffer = normalizedEmail && normalizedEmail.toLowerCase() !== foundEmail.toLowerCase();
        const shouldSyncEmail = Boolean(found.id && normalizedEmail && (emailsDiffer || domain === 'importado.placeholder'));

        if (shouldSyncEmail) {
          try {
            const updated = await updateSignerEmail(found.id, normalizedEmail, normalizedPhone || undefined);
            const updatedData = updated?.data || updated;
            if (updatedData && typeof updatedData === 'object') {
              found = { ...found, ...updatedData };
            }
          } catch (err) {
            if (DEBUG) console.warn('[ASSINAFY] updateSignerEmail falhou:', err.response?.status || err.message);
          }
          if (normalizedEmail) found.email = normalizedEmail;
          if (normalizedPhone) {
            if ('telephone' in found) found.telephone = normalizedPhone;
            else if ('phone' in found) found.phone = normalizedPhone;
            else found.telephone = normalizedPhone;
          }
        }

        if (!normalizedEmail && emailsDiffer) {
          // Se o novo e-mail estiver vazio, preserva o valor atual.
          return found;
        }

        if (emailsDiffer && normalizedEmail && !shouldSyncEmail) {
          // Sem ID não é possível sincronizar, mas refletimos o e-mail informado.
          found = { ...found, email: normalizedEmail };
        }

        return found;
      }
    }
    throw e;
  }
}

/* ---------------------------- Assignments c/fallback ------------------------ */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  if (!Array.isArray(signerIds) || !signerIds.length) throw new Error('Informe ao menos um signerId.');
  const body = { method: 'virtual', signerIds };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at;

  let url = `/documents/${encodeURIComponent(documentId)}/assignments`;
  if (DEBUG) console.log('[ASSINAFY][POST try#1]', BASE + url, body);
  let resp = await http.post(url, body);

  if (resp.status === 404) {
    url = `/accounts/${ACCOUNT_ID}/documents/${encodeURIComponent(documentId)}/assignments`;
    if (DEBUG) console.log('[ASSINAFY][POST try#2]', BASE + url, body);
    resp = await http.post(url, body);
  }

  if (resp.status === 409) {
    if (DEBUG) console.log('[ASSINAFY][assignments] 409 — assignment já existe.');
    return resp.data || { reused: true };
  }

  const ok = ensureOk(resp, 'requestSignatures');

  // Tentativa imediata de obter sign_url/public_link/token do assignment criado
  try {
    const assignmentId = ok?.assignment?.id || ok?.id;
    if (assignmentId) {
      const urlA = `/assignments/${encodeURIComponent(assignmentId)}`;
      if (DEBUG) console.log('[ASSINAFY][GET assignment]', BASE + urlA);
      const aResp = await http.get(urlA);
      const aOk = ensureOk(aResp, 'getAssignment');
      const a = aOk?.data || aOk;
      let link = pickAssignmentUrl(a);
      if (!link && a?.token) {
        link = `https://app.assinafy.com.br/verify/${a.token}`;
      }
      ok.assignment = a;
      ok.assinatura_url = link || null;
      if (!link) {
        console.log(`[ASSINAFY][requestSignatures] nenhuma URL de assinatura retornada (status: ${a?.status})`);
      }
    }
  } catch (err) {
    if (DEBUG) console.warn('[ASSINAFY][requestSignatures] falha ao obter assignment:', err?.response?.status || err.message);
  }

  return ok;
}
async function getAssignmentFromDocument(documentId) {
  const doc = await getDocument(documentId);
  const info = doc?.data || doc;
  return info?.assignment || null;
}

/* ------------------------- URL de assinatura (robusto) ---------------------- */
function pickAssignmentUrl(a) {
  return (
    a?.sign_url || a?.signer_url || a?.signerUrl || a?.signing_url ||
    a?.url || a?.link || a?.deep_link || a?.deeplink || a?.access_link || a?.public_link || null
  );
}
function collectSignerIds(obj, depth = 0, set = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 5) return set;
  if (Array.isArray(obj)) {
    for (const it of obj) collectSignerIds(it, depth + 1, set);
    return set;
  }
  const candidate = obj.signer_id || obj.signerId || obj.signerID || obj.signer?.id || obj.signer?.signer_id || obj.signer?.signerId;
  if (candidate) set.add(candidate);
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (val && typeof val === 'object') collectSignerIds(val, depth + 1, set);
  }
  return set;
}
function extractSignerIds(obj) {
  return Array.from(collectSignerIds(obj));
}
function saveAssinaturaUrl(documentId, url) {
  if (!url) return Promise.resolve();
  const db = new sqlite3.Database(DB_PATH);
  return new Promise((resolve) => {
    db.run(
      `UPDATE documentos SET assinatura_url = ?, status = COALESCE(status,'pendente_assinatura') WHERE assinafy_id = ? AND assinatura_url IS NULL`,
      [url, documentId],
      () => {
        db.close();
        resolve();
      }
    );
  });
}

// ==============================================================================
//           ↓↓↓ SUBSTITUA A SUA FUNÇÃO getSigningUrl POR ESTA VERSÃO DE DEBUG ↓↓↓
// ==============================================================================
async function getSigningUrl(documentId) {
  try {
    console.log(`[DEBUG] Iniciando busca de token para o Documento ID: ${documentId}`);
    
    for (let i = 0; i < 5; i++) {
      if (i > 0) await sleep(2500); // Aumentamos um pouco a espera para 2.5 segundos

      const doc = await getDocument(documentId);
      const assignment = doc?.data?.assignment || doc?.assignment;

      // ========================== DEBUG LOG DETALHADO ==========================
      // Esta é a parte mais importante. Vamos imprimir o objeto 'assignment' inteiro.
      console.log(`\n===== [DEBUG][TENTATIVA ${i + 1}/5] para Documento ${documentId} =====`);
      console.log("Conteúdo COMPLETO do objeto 'assignment' recebido da API:");
      console.log(JSON.stringify(assignment, null, 2)); // Imprime o JSON formatado
      console.log("================================================================\n");
      // =======================================================================

      // A lógica para encontrar o token continua a mesma
      if (assignment?.token) {
        const url = `https://app.assinafy.com.br/verify/${assignment.token}`;
        console.log(`[ASSINAFY][getSigningUrl] SUCESSO! Token encontrado.`);
        await saveAssinaturaUrl(documentId, url);
        return url;
      }
    }

    console.warn(`[ASSINAFY][getSigningUrl] AVISO: Não foi possível encontrar o 'token' no objeto do documento ${documentId} após 5 tentativas.`);
    return null;

  } catch (e) {
    console.error('[ASSINAFY][getSigningUrl] ERRO CRÍTICO:', e?.response?.data || e.message);
    return null;
  }
}
// ==============================================================================
//           ↑↑↑ A SUBSTITUIÇÃO TERMINA AQUI ↑↑↑
// ==============================================================================

/* -------------------------------- Artifacts -------------------------------- */
function pickBestArtifactUrl(documentData) {
  const d = documentData?.data || documentData;
  const artifacts = d?.artifacts;

  // Quando artifacts for um array, procura pelo primeiro item cuja
  // propriedade `type` ou `kind` seja "certified" ou "certificated".
  if (Array.isArray(artifacts)) {
    const found = artifacts.find(it => {
      const t = String(it?.type || it?.kind || '').toLowerCase();
      return t === 'certified' || t === 'certificated';
    });
    if (found) {
      return (
        found?.url ||
        found?.link ||
        found?.href ||
        found?.download_url ||
        found?.downloadUrl ||
        null
      );
    }
    return null;
  }

  // Fallback para objetos com chaves nomeadas.
  const obj = artifacts || {};
  return obj.certified || obj.certificated || obj.original || null;
}

async function checkAssinafyHealth() {
  const overrideUrl = (process.env.ASSINAFY_HEALTHCHECK_URL || '').trim();
  const method = (process.env.ASSINAFY_HEALTHCHECK_METHOD || 'GET').toUpperCase();

  if (overrideUrl) {
    const config = {
      method,
      url: overrideUrl,
      timeout: TIMEOUT,
      headers: { Accept: 'application/json', ...authHeaders() },
      validateStatus: () => true,
    };

    if (method === 'POST') {
      config.data = { ping: true };
    }

    const resp = await axios(config);
    if (resp.status >= 200 && resp.status < 400) {
      return {
        via: 'override',
        method,
        statusCode: resp.status,
        url: overrideUrl,
      };
    }

    const err = new Error(`Health-check HTTP ${resp.status}`);
    err.response = resp;
    throw err;
  }

  if (!ACCOUNT_ID) {
    throw new Error('ASSINAFY_ACCOUNT_ID não configurado para health-check.');
  }

  const resp = await http.get(`/accounts/${encodeURIComponent(ACCOUNT_ID)}/signers`, {
    params: { per_page: 1, page: 1, limit: 1 },
  });

  if (resp.status >= 200 && resp.status < 300) {
    let sampleCount = null;
    const payload = resp.data;
    if (Array.isArray(payload)) sampleCount = payload.length;
    else if (payload && Array.isArray(payload.data)) sampleCount = payload.data.length;

    return {
      via: 'api',
      statusCode: resp.status,
      sampleCount,
    };
  }

  const err = new Error(`Health-check HTTP ${resp.status}`);
  err.response = resp;
  throw err;
}

module.exports = {
  uploadDocumentFromFile,
  getDocument,

  // waits
  waitForDocumentReady,
  waitUntilReadyForAssignment,
  waitUntilPendingSignature,

  // signers
  createSigner,
  findSignerByEmail,
  findSignerByGovernmentId,
  updateSignerEmail,
  ensureSigner,

  // assignments
  requestSignatures,
  getAssignmentFromDocument,
  getSigningUrl,

  // utils
  pickBestArtifactUrl,
  onlyDigits,
  checkAssinafyHealth,
};
