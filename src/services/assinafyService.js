// src/services/assinafyService.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE = process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1';
const ACCOUNT_ID = process.env.ASSINAFY_ACCOUNT_ID;

// Status do Assinafy considerados finais (documento processado)
const FINAL_STATUSES = new Set(['available', 'ready', 'waiting_for_assignments']);

function authHeaders() {
  const apiKey = process.env.ASSINAFY_API_KEY;
  const bearer = process.env.ASSINAFY_ACCESS_TOKEN;
  if (apiKey) return { 'X-Api-Key': apiKey }; // recomendado pela doc
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

function assertAccount() {
  if (!ACCOUNT_ID) throw new Error('ASSINAFY_ACCOUNT_ID não configurado.');
}

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
  return resp.data; // contém { id, status, artifacts: { original } }
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
  return resp.data; // geralmente { id, full_name, email, ... }
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
 * PREPARAR (assignment virtual): dispara a assinatura para um documento já enviado.
 * Endpoint: POST /documents/:documentId/assignments
 * Body: { method: "virtual", signerIds: [ ... ], message?, expires_at? }
 */
async function requestSignatures(documentId, signerIds, { message, expires_at } = {}) {
  assertAccount();
  if (!documentId) throw new Error('documentId é obrigatório.');
  if (!Array.isArray(signerIds) || signerIds.length === 0) {
    throw new Error('Informe ao menos um signerId.');
  }

  const body = { method: 'virtual', signerIds: signerIds.slice() };
  if (message) body.message = message;
  if (expires_at) body.expires_at = expires_at; // ISO (opcional)

  const url = `${BASE}/documents/${encodeURIComponent(documentId)}/assignments`;
  const resp = await axios.post(
    url,
    body,
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

/**
 * Consulta um documento no Assinafy (status + artifacts).
 * Endpoint: GET /documents/:documentId
 */
async function getDocument(documentId) {
  assertAccount();
  const url = `${BASE}/documents/${encodeURIComponent(documentId)}`;
  const resp = await axios.get(url, { headers: { ...authHeaders() } });
  return resp.data?.data || resp.data;
}

/**
 * (LEGADO) "prepareDocument": não existe endpoint /prepare.
 * Usar requestSignatures(documentId, [signerId], ...).
 * Mantemos a função para compatibilidade, redirecionando para o fluxo certo.
 */
async function prepareDocument(documentId, fieldsOrOptions = {}) {
  const { signerIds, message, expires_at } = fieldsOrOptions || {};
  if (!Array.isArray(signerIds) || signerIds.length === 0) {
    throw new Error('prepareDocument: forneça signerIds; preparar = criar assignment virtual.');
  }
  return requestSignatures(documentId, signerIds, { message, expires_at });
}

/**
 * Aguarda até que o documento esteja processado para poder receber assignment
 * Estados transitórios comuns: "uploading", "metadata_processing"
 * Consideramos processado quando sair desses estados OU quando já estiver
 * pronto p/ assinatura: "pending_signature" (ou final: "certificated").
 */
async function waitForDocumentReady(
  documentId,
  { retries = 15, intervalMs = 2000 } = {},
) {
  const PROCESSED_OR_WAITING = new Set([
    'pending_signature', 'waiting_for_assignments', 'available', 'ready', 'certificated', 'signed'
  ]);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const data = await getDocument(documentId);
      const info = data?.data || data;
      const status = info?.status;

      console.log(`Assinafy document ${documentId} status (attempt ${attempt + 1}/${retries}): ${status}`);

      if (!status || status === 'uploading' || status === 'metadata_processing') {
        // ainda processando — segue polling
      } else {
        // já processado / aguardando assinatura / assinado
        if (PROCESSED_OR_WAITING.has(status)) return info;
        // fallback: se não reconhecido mas saiu do processamento, também seguimos
        return info;
      }
    } catch (err) {
      const respStatus = err?.response?.status;
      console.log(
        `Assinafy document ${documentId} fetch error (attempt ${attempt + 1}/${retries}): ${respStatus || err.message}`,
      );
      // 404 pode acontecer em latência logo após upload — tenta de novo
      if (respStatus && respStatus !== 404) throw err;
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const err = new Error('Timeout ao aguardar processamento do documento.');
  err.timeout = true;
  throw err;
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


module.exports = {
  uploadDocumentFromFile,
  createSigner,
  ensureSigner,
  requestSignatures,
  getDocument,
  prepareDocument,
  waitForDocumentReady,
  pickBestArtifactUrl,
};
