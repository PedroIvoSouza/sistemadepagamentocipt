// src/api/adminStatusRoutes.js
const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { verifySmtpConnection } = require('../services/emailService');
const { checkSefazHealth } = require('../services/sefazService');
const { checkHealth: checkWhatsAppHealth } = require('../services/whatsappService');

const router = express.Router();
const execAsync = promisify(exec);

async function checkVpnHealth() {
  const url = (process.env.VPN_HEALTHCHECK_URL || '').trim();
  const timeout = Number(process.env.VPN_HEALTHCHECK_TIMEOUT_MS || 5000);

  if (url) {
    try {
      const method = (process.env.VPN_HEALTHCHECK_METHOD || 'GET').toUpperCase();
      const requestConfig = {
        method,
        url,
        timeout,
        validateStatus: () => true,
      };
      if (method === 'POST') {
        requestConfig.data = { ping: true };
      }
      const response = await axios(requestConfig);
      if (response.status >= 200 && response.status < 400) {
        return true;
      }
      throw new Error(`Health-check HTTP ${response.status}`);
    } catch (err) {
      const message = err?.message || err;
      throw new Error(typeof message === 'string' ? message : 'Falha no health-check HTTP da VPN.');
    }
  }

  const host = (process.env.VPN_HEALTHCHECK_HOST || '').trim();
  if (!host) {
    throw new Error('VPN_HEALTHCHECK_URL ou VPN_HEALTHCHECK_HOST não configurados.');
  }

  const seconds = Math.max(1, Math.ceil(timeout / 1000));
  const command = process.platform === 'win32'
    ? `ping -n 1 -w ${seconds * 1000} ${host}`
    : `ping -c 1 -W ${seconds} ${host}`;

  try {
    await execAsync(command, { timeout: timeout + 1000 });
    return true;
  } catch (err) {
    const message = err?.message || err;
    throw new Error(typeof message === 'string' ? message : 'Falha no ping da VPN.');
  }
}

router.get(
  '/service-status',
  [adminAuthMiddleware, authorizeRole(['SUPER_ADMIN'])],
  async (_req, res) => {
    const status = {
      email: 'erro',
      sefaz: 'erro',
      whatsapp: 'erro',
      vpn: 'erro',
    };

    const checks = [
      { key: 'email', fn: verifySmtpConnection },
      { key: 'sefaz', fn: checkSefazHealth },
      { key: 'whatsapp', fn: checkWhatsAppHealth },
      { key: 'vpn', fn: checkVpnHealth },
    ];

    for (const check of checks) {
      try {
        await check.fn();
        status[check.key] = 'ok';
      } catch (err) {
        status[check.key] = 'erro';
        console.error(`[SERVICE-STATUS] ${check.key} indisponível:`, err?.message || err);
      }
    }

    res.json(status);
  }
);

module.exports = router;
