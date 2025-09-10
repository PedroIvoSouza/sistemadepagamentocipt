// src/services/whatsappService.js
const axios = require('axios');

const BASE_URL = (process.env.WHATSAPP_BOT_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.WHATSAPP_BOT_TOKEN || '';

async function sendMessage(msisdn, text) {
  if (!BASE_URL) {
    console.warn('[WHATSAPP] WHATSAPP_BOT_URL não configurada.');
    return false;
  }
  try {
    const url = BASE_URL; // assume base already includes path
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    const body = { msisdn, text };
    const resp = await axios.post(url, body, { headers, timeout: 10000, validateStatus: () => true });
    if (resp.status >= 200 && resp.status < 300) {
      console.log('[WHATSAPP] mensagem enviada', msisdn);
      return true;
    }
    console.error('[WHATSAPP] falha HTTP', resp.status, resp.data);
    return false;
  } catch (err) {
    console.error('[WHATSAPP] erro ao enviar', err.message || err);
    return false;
  }
}

module.exports = { sendMessage };
