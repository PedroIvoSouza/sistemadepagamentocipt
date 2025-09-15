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

async function checkHealth() {
  const healthUrl = (process.env.WHATSAPP_HEALTHCHECK_URL || '').trim();
  const timeout = Number(process.env.WHATSAPP_HEALTHCHECK_TIMEOUT_MS || 5000);

  if (healthUrl) {
    try {
      const method = (process.env.WHATSAPP_HEALTHCHECK_METHOD || 'GET').toUpperCase();
      const headers = { 'Content-Type': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

      const requestConfig = {
        method,
        url: healthUrl,
        timeout,
        headers,
        validateStatus: () => true,
      };

      if (method === 'POST') {
        requestConfig.data = { ping: true };
      }

      const resp = await axios(requestConfig);
      if (resp.status >= 200 && resp.status < 400) {
        return true;
      }
      throw new Error(`Health-check HTTP ${resp.status}`);
    } catch (err) {
      throw new Error(err?.message || 'Falha ao consultar health-check do WhatsApp.');
    }
  }

  const msisdn = (process.env.WHATSAPP_HEALTHCHECK_MSISDN || process.env.WHATSAPP_TEST_MSISDN || '').trim();
  if (!msisdn) {
    throw new Error('WHATSAPP_HEALTHCHECK_MSISDN não configurado.');
  }

  const message = process.env.WHATSAPP_HEALTHCHECK_MESSAGE || 'ping';
  const ok = await sendMessage(msisdn, message);
  if (!ok) {
    throw new Error('Falha ao enviar mensagem de teste para o WhatsApp.');
  }

  return true;
}

module.exports = { sendMessage, checkHealth };
