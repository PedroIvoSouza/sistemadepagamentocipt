const axios = require('axios');
const FormData = require('form-data');

const BASE_URL = process.env.ASSINAFY_API_URL || 'https://api.assinafy.com';

function getApiKey() {
  const key = process.env.ASSINAFY_API_KEY;
  if (!key) throw new Error('ASSINAFY_API_KEY não configurado.');
  return key;
}

/**
 * Envia um PDF para assinatura
 * @param {Buffer} pdfBuffer
 * @param {string} filename
 * @param {object} config  { callbackUrl?: string, ...flags }
 */
async function uploadPdf(pdfBuffer, filename = 'documento.pdf', config = {}) {
  const apiKey = getApiKey();
  const form = new FormData();
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  const { callbackUrl = process.env.ASSINAFY_CALLBACK_URL, ...flags } = config || {};
  if (callbackUrl) form.append('callbackUrl', callbackUrl);

  Object.entries(flags).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      form.append(key, typeof value === 'boolean' ? String(value) : value);
    }
  });

  const resp = await axios.post(`${BASE_URL}/documents`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` }
  });
  return resp.data;
}

/** Consulta status do documento na Assinafy */
async function getDocumentStatus(id) {
  const apiKey = getApiKey();
  const resp = await axios.get(`${BASE_URL}/documents/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  return resp.data;
}

/** Baixa o PDF assinado (binário) */
async function downloadSignedPdf(id) {
  const apiKey = getApiKey();
  const resp = await axios.get(`${BASE_URL}/documents/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/pdf' },
    responseType: 'arraybuffer'
  });
  return resp.data; // Buffer
}

module.exports = {
  uploadPdf,
  getDocumentStatus,
  downloadSignedPdf
};
