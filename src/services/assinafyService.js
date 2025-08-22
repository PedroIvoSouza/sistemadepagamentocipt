// src/services/assinafyService.js
// Serviço “antigo” ajustado para funcionar com o rito novo,
// mantendo compatibilidade com chamadas legadas (inclui waitForDocumentReady).

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const ACCOUNT_ID = (process.env.ASSINAFY_ACCOUNT_ID || '').trim();

function assertAccount() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
}

function authHeaders() {
  const apiKey = (process.env.ASSINAFY_API_KEY || '').trim();
  const bearer = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
  if (apiKey) {
    // alguns gateways são sensíveis a case
    return { 'X-Api-Key': apiKey, 'X-API-KEY': apiKey, 'x-api-key': apiKey };
  }
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Upload de um PDF (a partir de arquivo) -> retorna payload do Assinafy
 * Endpoint: POST /accounts/:account_id/documents (multipart/form-data)
 */
async function uploadDocumentFromFile(filePath, filename) {
  assertAccount();
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: filename || path.basename(filePath),
    contentType: 'application/pdf'
  });

  const resp = await axios.post(
    `${BASE}/accounts/${ACCOUNT_ID}/documents`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
  return resp.data; // { id, status, artifacts: { original } }
}

/**
 * Cria um signatário (se precisar).
 * Endpoint: POST /accounts/:account_id/signers
 */
async function createSigner({ full_name, email, government_id, phone }) {
  assertAccount();
  if (!full_name || !email) throw new Error('full_name e email são obrigatórios para o signer.');

  const resp = await axios.post(
    `${BASE}/accounts/${ACCOUNT_ID}/signers`,
    { full_name, email, government_id, telephone: phone },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
  return resp.data; // { id, full_name, email, ... }
}

/**
 * Busca um signatário pelo e-mail.
 * Endpoint: GET /accounts/:account_id/signers?email=...
 */
async function findSignerByEmail(email) {
  assertAccount();
  const resp = await axios.get(
    `${BASE}/accounts/${ACCOUNT_ID}/signers`,
    { params: { email }, headers: { ...authHeaders() } }
  );
  const arr = Array.isArray(resp.data) ? resp.data : resp.data?.data;
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

/**
 * Garante a existência de um signatário reutilizando por e-mail.
 */
async function ensureSigner({ full_name, email, government_id, phone }) {
  try {
    return await createSigner({ full_name, email, government_id, phone });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || '';
    if (/já existe/i.test(msg) || /already exists/i.test(msg) || err?.response?.status === 400) {
      const found = await findSignerByEmail(email);
      if (found) return found;
    }
    throw err;
  }
}

/**
 * Consulta um documento no Assinafy (status + artifacts).
 * Endpoint: GET /documents/:documentId
 */
async function getDocument(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  return resp.data?.data || resp.data;
}

/**
 * Lista assignments de um documento (para obter a URL de assinatura).
 * Endpoint: GET /documents/:documentId/assignments
 */
async function listAssignments(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  const arr = Array.isArray(resp.data) ? resp.data : resp.data?.data;
  return Array.isArray(arr) ? arr : [];
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

/**
 * PREPARAR (assignment virtual): dispara a assinatura para um documento já enviado.
 * Endpoint: POST /documents/:documentId/assignments
 * Body: { method: "virtual", signerIds: [ ... ], message?, expires_at? }
 */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) {
    throw new Error('Informe ao menos um signerId.');
  }

  const body = { method: 'virtual', signerIds: signerIds.slice() };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at; // ISO (opcional)

  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.post(url, body, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' }
  });
  return resp.data;
}

/**
 * Aguarda processamento pós-upload (LEGADO, mantido p/ compatibilidade).
 * Considera processado quando sair de "uploading"/"metadata_processing",
 * ou quando já estiver em estados de espera/assinatura.
 */
async function waitForDocumentReady(
  documentId,
  { retries = 20, intervalMs = 1500 } = {},
) {
  const PROCESSED_OR_WAITING = new Set([
    'pending_signature',
    'waiting_for_assignments',
    'available',
    'ready',
    'certificated',
    'signed'
  ]);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const info = await getDocument(documentId);
      const status = info?.status;
      console.log(`Assinafy document ${documentId} status (attempt ${attempt + 1}/${retries}): ${status}`);

      if (!status || status === 'uploading' || status === 'metadata_processing') {
        // ainda processando
      } else {
        // processado/aguardando/assinado
        if (PROCESSED_OR_WAITING.has(status)) return info;
        return info; // se saiu do processamento, retorna mesmo assim
      }
    } catch (err) {
      const respStatus = err?.response?.status;
      console.log(`Assinafy document ${documentId} fetch error (attempt ${attempt + 1}/${retries}): ${respStatus || err.message}`);
      // 404 logo após upload pode ocorrer — tenta de novo
      if (respStatus && respStatus !== 404) throw err;
    }

    if (attempt < retries - 1) await sleep(intervalMs);
  }

  const err = new Error('Timeout ao aguardar processamento do documento.');
  err.timeout = true;
  throw err;
}

/**
 * Aguarda até ficar pronto para assinar (pending_signature) ou já assinado.
 */
async function waitForPendingSignature(documentId, { retries = 60, intervalMs = 1500 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const info = await getDocument(documentId);
    const status = info?.status;
    console.log(`Assinafy document ${documentId} status (attempt ${attempt + 1}/${retries}): ${status}`);
    if (status === 'pending_signature' || status === 'certificated') return info;
    await sleep(intervalMs);
  }
  const err = new Error('Timeout aguardando pending_signature.');
  err.timeout = true;
  throw err;
}

/**
 * (COMPATÍVEL) "prepareDocument":
 * Aceita EITHER signerIds OR { full_name, email, government_id?, phone?, message?, expires_at? }.
 * Internamente garante o signatário e cria o assignment virtual.
 * Retorna também a URL de assinatura.
 */
async function prepareDocument(documentId, opts = {}) {
  if (!documentId) throw new Error('documentId é obrigatório.');

  if (Array.isArray(opts.signerIds) && opts.signerIds.length > 0) {
    await requestSignatures(documentId, opts.signerIds, { message: opts.message, expires_at: opts.expires_at });
  } else if (opts.email && opts.full_name) {
    const signer = await ensureSigner({
      full_name: opts.full_name,
      email: opts.email,
      government_id: opts.government_id,
      phone: opts.phone
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) throw new Error('Falha ao garantir signatário.');
    await requestSignatures(documentId, [signerId], { message: opts.message, expires_at: opts.expires_at });
  } else {
    throw new Error('prepareDocument: forneça signerIds OU { full_name, email }.');
  }

  await waitForPendingSignature(documentId, { retries: 60, intervalMs: 1500 });

  const assinaturaUrl = await getBestSigningUrl(documentId);
  return { ok: true, documentId, assinaturaUrl };
}

/**
 * Retorna a melhor URL de download do PDF:
 *  - se existir artifacts.certificated, usa ela (assinado)
 *  - senão, usa artifacts.original (upload)
 */
function pickBestArtifactUrl(documentData) {
  const artifacts = documentData?.artifacts || {};
  return artifacts.certificated || artifacts.original || null;
}

/**
 * Baixa artefato assinado (buffer). Endpoint: GET /documents/:id/download/certificated
 */
async function downloadSignedArtifact(documentId) {
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/download/certificated`;
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { ...authHeaders(), Accept: 'application/pdf' }
  });
  if (resp.status >= 200 && resp.status < 300) return Buffer.from(resp.data);
  const err = new Error(`Falha ao baixar artefato assinado (HTTP ${resp.status})`);
  err.response = resp;
  throw err;
}

module.exports = {
  // upload / documento
  uploadDocumentFromFile,
  getDocument,

  // signers
  createSigner,
  findSignerByEmail,
  ensureSigner,

  // assignments / preparo
  requestSignatures,
  listAssignments,
  getBestSigningUrl,
  prepareDocument,

  // waits (legado + novo)
  waitForDocumentReady,       // <— mantém p/ compatibilidade
  waitForPendingSignature,

  // utils
  pickBestArtifactUrl,
  downloadSignedArtifact,
};
