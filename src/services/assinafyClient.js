// src/services/assinafyClient.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs'); // usado só no fallback de download por URL (opcional)

function getCredHeaders() {
  const apiKey = process.env.ASSINAFY_API_KEY?.trim();
  const bearer = process.env.ASSINAFY_ACCESS_TOKEN?.trim();
  // Preferência: X-Api-Key (v1)
  if (apiKey) return { 'X-Api-Key': apiKey };
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  throw new Error('Configure ASSINAFY_API_KEY ou ASSINAFY_ACCESS_TOKEN.');
}

function baseCandidates() {
  // 1) o que vier do .env
  const envs = [
    process.env.ASSINAFY_API_URL,   // pode já vir com /v1 ou /accounts/:id
    process.env.ASSINAFY_API_BASE,  // alternativa legada
  ].filter(Boolean);

  // 2) montar candidatos a partir do ACCOUNT_ID
  const acc = process.env.ASSINAFY_ACCOUNT_ID?.trim();
  if (acc) {
    envs.push(`https://api.assinafy.com.br/v1/accounts/${acc}`);
    envs.push(`https://api.assinafy.com.br/v1`); // caso precise cair para /documents sem account
  }

  // 3) defaults finais
  envs.push('https://api.assinafy.com.br/v1');
  envs.push('https://api.assinafy.com.br');

  // normaliza e remove duplicados
  const seen = new Set();
  return envs
    .map(s => String(s).replace(/\/+$/,''))
    .filter(s => { if (seen.has(s)) return false; seen.add(s); return true; });
}

function buildDocumentEndpoints() {
  const bases = baseCandidates();
  const endpoints = [];
  const acc = process.env.ASSINAFY_ACCOUNT_ID?.trim();

  for (const b of bases) {
    // se já vier com /accounts/:id
    if (/\/accounts\/[^/]+$/i.test(b)) {
      endpoints.push(`${b}/documents`);
      continue;
    }
    // se for /v1 e tenho account_id, prioriza o endpoint com account
    if (/\/v1$/i.test(b) && acc) {
      endpoints.push(`${b}/accounts/${acc}/documents`);
    }
    // tenta /documents direto
    endpoints.push(`${b}/documents`);
  }
  return endpoints;
}

async function postMultipartToFirstAlive(form) {
  const headers = { ...getCredHeaders(), ...form.getHeaders() };
  const endpoints = buildDocumentEndpoints();

  let lastErr;
  for (const url of endpoints) {
    try {
      const resp = await axios.post(url, form, { headers, timeout: 20000 });
      return { data: resp.data, used: url };
    } catch (e) {
      // se for erro de DNS/rede, tenta o próximo
      const code = e?.code || e?.cause?.code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
        lastErr = e; continue;
      }
      // se for 404/401/403, pode ser endpoint errado—tenta próximos também
      if (e?.response?.status && [401,403,404,405].includes(e.response.status)) {
        lastErr = e; continue;
      }
      // outros erros: já devolve
      throw e;
    }
  }
  throw lastErr || new Error('Falha ao contatar qualquer endpoint Assinafy.');
}

function getApiKey() {
  // compat com seu código antigo (não usado se X-Api-Key estiver configurado)
  const key = process.env.ASSINAFY_API_KEY || process.env.ASSINAFY_ACCESS_TOKEN;
  if (!key) throw new Error('ASSINAFY_API_KEY/ACCESS_TOKEN não configurado.');
  return key;
}

/**
 * Envia PDF (Buffer) — mantém a mesma assinatura que você já usa
 */
async function uploadPdf(pdfBuffer, filename = 'documento.pdf', config = {}) {
  const form = new FormData();
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  const { callbackUrl = process.env.ASSINAFY_CALLBACK_URL, ...flags } = config || {};
  if (callbackUrl) form.append('callbackUrl', callbackUrl);

  Object.entries(flags).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      form.append(key, typeof value === 'boolean' ? String(value) : value);
    }
  });

  const { data, used } = await postMultipartToFirstAlive(form);
  // Opcional: log para ver qual URL funcionou
  console.log('[ASSINAFY] upload OK via:', used);
  return data;
}

/**
 * Status do documento
 */
async function getDocumentStatus(id) {
  const headers = { ...getCredHeaders() };
  const bases = buildDocumentEndpoints().map(u => u.replace(/\/documents$/,''));
  // tenta GET /documents/:id em todos os bases possíveis
  let lastErr;
  for (const base of bases) {
    try {
      const resp = await axios.get(`${base}/documents/${id}`, { headers, timeout: 15000 });
      return resp.data;
    } catch (e) {
      lastErr = e; continue;
    }
  }
  throw lastErr || new Error('Falha ao consultar documento no Assinafy.');
}

/**
 * Baixar PDF assinado — tenta binário direto; se não rolar, devolve a melhor URL
 */
async function downloadSignedPdf(id) {
  const headers = { ...getCredHeaders(), Accept: 'application/pdf' };
  const bases = buildDocumentEndpoints().map(u => u.replace(/\/documents$/,''));
  // 1) tentativa: GET binário
  for (const base of bases) {
    try {
      const resp = await axios.get(`${base}/documents/${id}`, {
        headers, responseType: 'arraybuffer', timeout: 20000
      });
      // se veio PDF correto, retorna buffer
      const ct = resp.headers?.['content-type'] || '';
      if (/application\/pdf/i.test(ct) || resp.data?.byteLength) {
        return resp.data;
      }
    } catch {}
  }
  // 2) fallback: buscar metadata e retornar URL do artifact (para quem chamou baixar)
  for (const base of bases) {
    try {
      const resp = await axios.get(`${base}/documents/${id}`, { headers, timeout: 15000 });
      const artifacts = resp.data?.artifacts || {};
      const url = artifacts.certificated || artifacts.original || null;
      if (url) return { url };
    } catch {}
  }
  throw new Error('Não foi possível obter o PDF do documento.');
}

module.exports = {
  uploadPdf,
  getDocumentStatus,
  downloadSignedPdf
};
