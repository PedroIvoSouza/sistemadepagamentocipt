// src/api/adminStatusRoutes.js
const express = require('express');
const axios = require('axios');
const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const db = require('../database/db');
const { verifySmtpConnection } = require('../services/emailService');
const { checkSefazHealth } = require('../services/sefazService');
const { checkHealth: checkWhatsAppHealth } = require('../services/whatsappService');
const { checkAssinafyHealth } = require('../services/assinafyService');
const { fetchCnpjData } = require('../services/cnpjLookupService');
const { fetchCepAddress } = require('../services/cepLookupService');

const router = express.Router();
const execAsync = promisify(exec);

const DEFAULT_CNPJ = '00000000000191';
const DEFAULT_CEP = '01001000';

const cleanDigits = (value) => String(value || '').replace(/\D/g, '');

function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'servico';
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total < 0) return `${seconds || 0}s`;
  const parts = [];
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}min`);
  if (!parts.length || secs) parts.push(`${secs}s`);
  return parts.join(' ');
}

function extractErrorMessage(error) {
  if (!error) return 'Erro desconhecido.';
  if (typeof error === 'string') return error;
  const parts = [];
  if (error.message) parts.push(error.message);
  const status = error.response?.status;
  if (status) parts.push(`HTTP ${status}`);
  if (error.code) parts.push(`código ${error.code}`);
  return parts.join(' - ') || 'Erro desconhecido.';
}

function buildErrorDetails(error) {
  if (!error) return undefined;
  if (error.response && error.response.data) {
    try {
      if (typeof error.response.data === 'string') {
        return error.response.data.slice(0, 500);
      }
      return JSON.stringify(error.response.data).slice(0, 500);
    } catch (jsonErr) {
      return error.response.data;
    }
  }
  if (error.stack) {
    return error.stack;
  }
  return undefined;
}

async function checkDatabaseConnectivity() {
  const storage = process.env.SQLITE_STORAGE || './sistemacipt.db';
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 AS ok', (err, row) => {
      if (err) return reject(err);
      resolve({ storage, ok: row?.ok === 1 });
      return null;
    });
  });
}

async function checkApplicationServer() {
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    nodeEnv: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    memoryRss: memory?.rss || null,
  };
}

async function checkEmailService() {
  await verifySmtpConnection();
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'SMTP';
  const portRaw = process.env.SMTP_PORT || process.env.EMAIL_PORT;
  const port = portRaw ? Number(portRaw) : undefined;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  return { host, port, secure };
}

async function checkSefazService() {
  await checkSefazHealth();
  return {
    mode: (process.env.SEFAZ_MODE || 'hom').toString().toLowerCase(),
  };
}

async function checkVpnConnectivity() {
  const url = (process.env.VPN_HEALTHCHECK_URL || '').trim();
  const timeout = Number(process.env.VPN_HEALTHCHECK_TIMEOUT_MS || 5000);
  const method = (process.env.VPN_HEALTHCHECK_METHOD || 'GET').toUpperCase();

  const allowInsecureTls = /^true|1$/i.test(
    (process.env.VPN_HEALTHCHECK_TLS_INSECURE || '').trim()
  );

  if (url) {
    const insecureContext = allowInsecureTls
      ? { insecureTls: true, method: 'http', url }
      : null;
    try {
      const httpsAgent = allowInsecureTls
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined;
      const response = await axios({
        method,
        url,
        timeout,
        validateStatus: () => true,
        ...(httpsAgent ? { httpsAgent } : {}),
        ...(method === 'POST' ? { data: { ping: true } } : {}),
      });
      if (response.status >= 200 && response.status < 400) {
        return {
          method: 'http',
          url,
          statusCode: response.status,
          insecureTls: allowInsecureTls,
        };
      }
      const err = new Error(`Health-check HTTP ${response.status}`);
      err.response = response;
      if (insecureContext) err.meta = { ...insecureContext };
      throw err;
    } catch (error) {
      const message = error?.message || error;
      const wrapped =
        typeof message === 'string'
          ? new Error(message)
          : new Error('Falha no health-check HTTP da VPN.');
      wrapped.cause = error;
      if (error?.meta) {
        wrapped.meta = { ...error.meta };
      } else if (insecureContext) {
        wrapped.meta = { ...insecureContext };
      }
      throw wrapped;
    }
  }

  const host = (process.env.VPN_HEALTHCHECK_HOST || '').trim();
  if (!host) {
    throw new Error('VPN_HEALTHCHECK_URL ou VPN_HEALTHCHECK_HOST não configurados.');
  }

  const seconds = Math.max(1, Math.ceil(timeout / 1000));
  const command =
    process.platform === 'win32'
      ? `ping -n 1 -w ${seconds * 1000} ${host}`
      : `ping -c 1 -W ${seconds} ${host}`;

  try {
    await execAsync(command, { timeout: timeout + 1000 });
    return { method: 'ping', host };
  } catch (error) {
    const message = error?.message || error;
    const wrapped =
      typeof message === 'string'
        ? new Error(message)
        : new Error('Falha no ping da VPN.');
    wrapped.cause = error;
    throw wrapped;
  }
}

async function checkWhatsAppService() {
  await checkWhatsAppHealth();
  const hasUrl = !!(process.env.WHATSAPP_HEALTHCHECK_URL || '').trim();
  const target = hasUrl
    ? (process.env.WHATSAPP_HEALTHCHECK_URL || '').trim()
    : (process.env.WHATSAPP_HEALTHCHECK_MSISDN ||
        process.env.WHATSAPP_TEST_MSISDN ||
        '').trim();
  return {
    via: hasUrl ? 'http' : 'message',
    target: target || null,
  };
}

async function checkAssinafyService() {
  return checkAssinafyHealth();
}

async function checkBrasilApiService() {
  const cnpj = cleanDigits(process.env.BRASILAPI_HEALTHCHECK_CNPJ || DEFAULT_CNPJ);
  if (!cnpj) {
    throw new Error('BRASILAPI_HEALTHCHECK_CNPJ inválido.');
  }
  const data = await fetchCnpjData(cnpj);
  if (!data) {
    throw new Error('Resposta vazia da BrasilAPI para o CNPJ informado.');
  }
  return {
    cnpj,
    razaoSocial: data.razao_social || data.nome_fantasia || null,
  };
}

async function checkViaCepService() {
  const cep = cleanDigits(process.env.VIACEP_HEALTHCHECK_CEP || DEFAULT_CEP);
  if (!cep) {
    throw new Error('VIACEP_HEALTHCHECK_CEP inválido.');
  }
  const data = await fetchCepAddress(cep);
  return {
    cep,
    localidade: data.localidade || data.cidade || null,
    uf: data.uf || null,
  };
}

async function runCheck(config, accumulator) {
  const {
    name,
    identifier = slugify(name),
    check,
    successDescription,
    failureDescription,
    onSuccess,
    onError,
  } = config;

  const startedAt = Date.now();
  try {
    const result = await check();
    const durationMs = Date.now() - startedAt;
    const description =
      typeof successDescription === 'function'
        ? successDescription(result, { durationMs })
        : successDescription || 'Operacional.';
    const entry = {
      identifier,
      name,
      status: 'up',
      description,
      checkedAt: new Date().toISOString(),
      durationMs,
    };
    if (typeof onSuccess === 'function') {
      const extra = onSuccess(result, { durationMs });
      if (extra && typeof extra === 'object') {
        if (extra.meta) entry.meta = extra.meta;
        if (extra.details) entry.details = extra.details;
      }
    }
    accumulator.push(entry);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const description =
      typeof failureDescription === 'function'
        ? failureDescription(error, { durationMs })
        : failureDescription || 'Indisponível no momento.';
    const message = extractErrorMessage(error);
    const entry = {
      identifier,
      name,
      status: 'down',
      description,
      message: `Erro: ${message}`,
      checkedAt: new Date().toISOString(),
      durationMs,
    };
    const details = buildErrorDetails(error);
    if (details) entry.details = details;

    if (typeof onError === 'function') {
      const extra = onError(error, { durationMs, message });
      if (extra && typeof extra === 'object') {
        if (extra.status) entry.status = extra.status;
        if (extra.description) entry.description = extra.description;
        if (extra.message) entry.message = extra.message;
        if (extra.details) entry.details = extra.details;
        if (extra.meta) entry.meta = extra.meta;
      }
    }

    console.error(`[SERVICE-STATUS] ${identifier} indisponível:`, message);
    accumulator.push(entry);
  }
}

async function runServiceHealthChecks() {
  const services = [];

  const checks = [
    {
      name: 'Banco de Dados (SQLite)',
      identifier: 'database-sqlite',
      check: checkDatabaseConnectivity,
      successDescription: (result, { durationMs }) => {
        const storage = result?.storage || process.env.SQLITE_STORAGE || './sistemacipt.db';
        return `Consulta teste executada em ${durationMs} ms (arquivo ${storage}).`;
      },
      failureDescription: 'Falha ao executar consulta no banco de dados SQLite.',
      onSuccess: (result) => ({
        meta: {
          storage: result?.storage || process.env.SQLITE_STORAGE || './sistemacipt.db',
        },
      }),
    },
    {
      name: 'Servidor de Aplicação',
      identifier: 'application-server',
      check: checkApplicationServer,
      successDescription: (result) => {
        const uptime = formatDuration(result?.uptimeSeconds);
        const mode = result?.nodeEnv || process.env.NODE_ENV || 'development';
        return `Processo ${process.pid} ativo há ${uptime} (${mode}).`;
      },
      failureDescription: 'Servidor de aplicação inativo.',
      onSuccess: (result) => ({
        meta: {
          uptimeSeconds: result?.uptimeSeconds,
          nodeEnv: result?.nodeEnv,
          nodeVersion: result?.nodeVersion,
          memoryRss: result?.memoryRss,
        },
      }),
    },
    {
      name: 'Envio de E-mail (SMTP)',
      identifier: 'email-smtp',
      check: checkEmailService,
      successDescription: (result) => {
        const host = result?.host || 'SMTP';
        const port = result?.port ? `:${result.port}` : '';
        const secure = result?.secure ? ' com TLS' : '';
        return `Servidor ${host}${port} respondeu ao teste${secure}.`;
      },
      failureDescription: 'Não foi possível validar o servidor de e-mail.',
      onSuccess: (result) => ({
        meta: {
          host: result?.host,
          port: result?.port,
          secure: !!result?.secure,
        },
      }),
      onError: (_error, { message }) => {
        if (/DISABLE_EMAIL/i.test(message)) {
          return {
            description: 'Envio de e-mails desativado por configuração (DISABLE_EMAIL=true).',
          };
        }
        if (/SMTP.*configurado/i.test(message) || /incompleta/i.test(message)) {
          return {
            description: 'Servidor SMTP não configurado nas variáveis de ambiente.',
          };
        }
        return null;
      },
    },
    {
      name: 'Integração SEFAZ',
      identifier: 'sefaz',
      check: checkSefazService,
      successDescription: (_result, { durationMs }) => {
        const mode = (process.env.SEFAZ_MODE || 'hom').toUpperCase();
        return `API da SEFAZ (${mode}) respondeu em ${durationMs} ms.`;
      },
      failureDescription: 'SEFAZ não respondeu ao teste de saúde.',
      onSuccess: (result) => ({
        meta: {
          mode: result?.mode || process.env.SEFAZ_MODE || 'hom',
        },
      }),
    },
    {
      name: 'Conectividade VPN/Infovia',
      identifier: 'vpn',
      check: checkVpnConnectivity,
      successDescription: (result) => {
        if (result?.method === 'http') {
          const insecureNote = result?.insecureTls
            ? ' (TLS inseguro habilitado)'
            : '';
          return `Endpoint ${result.url} respondeu com HTTP ${result.statusCode}${insecureNote}.`;
        }
        return `Host ${result?.host || 'VPN'} respondeu ao ping.`;
      },
      failureDescription: 'Falha na verificação da VPN/infovia.',
      onSuccess: (result) => ({
        meta: result || {},
      }),
      onError: (error, { message }) => {
        const context = error?.meta || error?.cause?.meta;
        if (context?.insecureTls) {
          const url = context.url || 'endpoint HTTP';
          return {
            description: `Falha na verificação da VPN/infovia (TLS inseguro habilitado para ${url}).`,
            meta: { ...context },
          };
        }
        if (/não configurad/i.test(message)) {
          return {
            description: 'Configuração do health-check da VPN ausente.',
          };
        }
        if (context) {
          return {
            meta: { ...context },
          };
        }
        return null;
      },
    },
    {
      name: 'Bot de WhatsApp',
      identifier: 'whatsapp-bot',
      check: checkWhatsAppService,
      successDescription: (result) =>
        result?.via === 'http'
          ? 'Health-check HTTP do bot respondeu com sucesso.'
          : 'Mensagem de teste enviada com sucesso para o bot do WhatsApp.',
      failureDescription: 'Bot do WhatsApp não respondeu ao teste.',
      onSuccess: (result) => ({
        meta: result || {},
      }),
      onError: (_error, { message }) => {
        if (/não configurad/i.test(message)) {
          return {
            description: 'Configuração do bot de WhatsApp incompleta (URL/token ou número de teste).',
          };
        }
        return null;
      },
    },
    {
      name: 'Assinaturas Digitais (Assinafy)',
      identifier: 'assinafy',
      check: checkAssinafyService,
      successDescription: (result) => {
        if (result?.via === 'override') {
          return `Health-check personalizado da Assinafy retornou HTTP ${result.statusCode}.`;
        }
        return 'API da Assinafy respondeu à consulta de teste.';
      },
      failureDescription: 'Assinafy não respondeu ao teste de integridade.',
      onSuccess: (result) => ({
        meta: result || {},
      }),
      onError: (_error, { message }) => {
        if (/não configurado/i.test(message)) {
          return {
            description: 'Credenciais da Assinafy não configuradas.',
          };
        }
        return null;
      },
    },
    {
      name: 'Consulta de CNPJ (BrasilAPI)',
      identifier: 'brasilapi-cnpj',
      check: checkBrasilApiService,
      successDescription: (result) => {
        const empresa = result?.razaoSocial || 'CNPJ de teste';
        return `BrasilAPI respondeu pela empresa ${empresa}.`;
      },
      failureDescription: 'BrasilAPI não respondeu à consulta de CNPJ.',
      onSuccess: (result) => ({
        meta: result || {},
      }),
    },
    {
      name: 'Consulta de CEP (ViaCEP)',
      identifier: 'viacep',
      check: checkViaCepService,
      successDescription: (result) => {
        const cidade = [result?.localidade, result?.uf].filter(Boolean).join(' / ');
        return `ViaCEP respondeu para o CEP ${result?.cep}${cidade ? ` (${cidade})` : ''}.`;
      },
      failureDescription: 'ViaCEP não respondeu à consulta de CEP.',
      onSuccess: (result) => ({
        meta: result || {},
      }),
    },
  ];

  for (const item of checks) {
    await runCheck(item, services);
  }

  return services;
}

router.get(
  '/service-status',
  [adminAuthMiddleware, authorizeRole(['SUPER_ADMIN'])],
  async (_req, res) => {
    try {
      const services = await runServiceHealthChecks();
      res.json({
        generatedAt: new Date().toISOString(),
        environment: {
          node: process.version,
          nodeEnv: process.env.NODE_ENV || 'development',
        },
        services,
      });
    } catch (error) {
      console.error('[SERVICE-STATUS] Falha geral:', error);
      res.status(500).json({
        generatedAt: new Date().toISOString(),
        error: 'Falha ao executar health-check dos serviços.',
        details: extractErrorMessage(error),
      });
    }
  },
);

module.exports = router;
