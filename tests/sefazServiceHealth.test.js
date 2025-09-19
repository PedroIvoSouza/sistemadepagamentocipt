const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../src/services/sefazService.js');
const Module = require('module');

function withAxiosMock(onGet) {
  const originalLoad = Module._load;
  Module._load = function mockAxios(request, parent, isMain) {
    if (request === 'axios') {
      return {
        create: (config) => ({
          config,
          interceptors: {
            request: { use: () => {} },
            response: { use: () => {} },
          },
          get: async (url, options) => onGet(url, options),
          post: async () => ({ data: {} }),
        }),
      };
    }
    if (request === 'dotenv') {
      return { config: () => ({}) };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[servicePath];
  const svc = require(servicePath);

  return {
    ...svc,
    restore: () => {
      delete require.cache[servicePath];
      Module._load = originalLoad;
    },
  };
}

test('checkSefazHealth aceita código com dígito verificador', async () => {
  const envKeys = [
    'SEFAZ_APP_TOKEN',
    'SEFAZ_HEALTHCHECK_RECEITA_CODIGO',
    'RECEITA_CODIGO_PERMISSIONARIO',
    'RECEITA_CODIGO_EVENTO',
    'RECEITA_CODIGO_EVENTO_PF',
    'RECEITA_CODIGO_EVENTO_PJ',
    'SEFAZ_MIN_CONSULTA_INTERVAL_MS',
  ];
  const previousEnv = {};
  for (const key of envKeys) {
    previousEnv[key] = process.env[key];
  }

  process.env.SEFAZ_APP_TOKEN = 'token-saude';
  process.env.SEFAZ_HEALTHCHECK_RECEITA_CODIGO = '20165-1';
  process.env.RECEITA_CODIGO_PERMISSIONARIO = '';
  process.env.RECEITA_CODIGO_EVENTO = '';
  process.env.RECEITA_CODIGO_EVENTO_PF = '';
  process.env.RECEITA_CODIGO_EVENTO_PJ = '';
  process.env.SEFAZ_MIN_CONSULTA_INTERVAL_MS = '0';

  const calls = [];
  const { checkSefazHealth, restore } = withAxiosMock(async (url, options) => {
    calls.push({ url, options });
    return { data: { ok: true } };
  });

  try {
    const result = await checkSefazHealth();
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/public/receita/consultar');
    assert.equal(calls[0].options.params.codigo, 20165);
    assert.equal(typeof calls[0].options.params.codigo, 'number');
  } finally {
    restore();
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  }
});
