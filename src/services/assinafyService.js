const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const BASE_URL = process.env.ASSINAFY_API_URL || 'https://api.assinafy.com';

function getApiKey() {
  const key = process.env.ASSINAFY_API_KEY;
  if (!key) throw new Error('ASSINAFY_API_KEY não configurado.');
  return key;
}

async function uploadPdf(pdfBuffer, filename = 'documento.pdf') {
  const apiKey = getApiKey();
  const form = new FormData();
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  const resp = await axios.post(`${BASE_URL}/documents`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${apiKey}`
    }
  });
  return resp.data;
}

async function getDocumentStatus(id) {
  const apiKey = getApiKey();
  const resp = await axios.get(`${BASE_URL}/documents/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  return resp.data;
}

async function downloadSignedPdf(id) {
  const apiKey = getApiKey();
  const resp = await axios.get(`${BASE_URL}/documents/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/pdf' },
    responseType: 'arraybuffer'
  });
  return resp.data;
}

module.exports = {
  uploadPdf,
  getDocumentStatus,
  downloadSignedPdf
};

