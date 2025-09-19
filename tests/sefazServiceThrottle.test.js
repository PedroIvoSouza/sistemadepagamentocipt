const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('module');

const servicePath = path.resolve(__dirname, '../src/services/sefazService.js');

function withAxiosMock({ onGet, onPost }) {
  const originalLoad = Module._load;
  Module._load = function mockAxios(request, parent, isMain) {
    if (request === 'axios') {
      return {
        create: () => ({
          interceptors: {
            request: { use: () => {} },
            response: { use: () => {} },
          },
          get: onGet || (async () => ({ data: {} })),
          post: onPost || (async () => ({ data: [] })),
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

test('consultas à SEFAZ são serializadas respeitando intervalo mínimo', async () => {
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

  const minInterval = 30;
  process.env.SEFAZ_APP_TOKEN = 'token-serial';
  process.env.SEFAZ_HEALTHCHECK_RECEITA_CODIGO = '20165-1';
  process.env.RECEITA_CODIGO_PERMISSIONARIO = '';
  process.env.RECEITA_CODIGO_EVENTO = '';
  process.env.RECEITA_CODIGO_EVENTO_PF = '';
  process.env.RECEITA_CODIGO_EVENTO_PJ = '';
  process.env.SEFAZ_MIN_CONSULTA_INTERVAL_MS = String(minInterval);

  const chamadas = [];
  let ativa = 0;
  let maxAtiva = 0;

  const registrar = async (tipo, url) => {
    chamadas.push({ tipo, url, inicio: Date.now() });
    ativa += 1;
    maxAtiva = Math.max(maxAtiva, ativa);
    await new Promise((resolve) => setTimeout(resolve, 15));
    ativa -= 1;
  };

  const { consultarReceita, listarPagamentosPorDataArrecadacao, consultarPagamentoPorCodigoBarras, listarPagamentosPorDataInclusao, checkSefazHealth, restore } = withAxiosMock({
    onGet: async (url, options) => {
      await registrar('GET', url, options);
      return { data: { ok: true, url, options } };
    },
    onPost: async (url, payload) => {
      await registrar('POST', url, payload);
      return { data: [{}] };
    },
  });

  try {
    await Promise.all([
      consultarReceita('20165-1'),
      listarPagamentosPorDataArrecadacao('2025-01-01', '2025-01-02'),
      consultarPagamentoPorCodigoBarras('1234567890123'),
      listarPagamentosPorDataInclusao('2025-01-01T00:00:00', '2025-01-02T23:59:59'),
      checkSefazHealth(),
    ]);

    assert.equal(chamadas.length, 5);
    assert.equal(maxAtiva, 1, 'Chamadas devem ser serializadas.');

    for (let i = 0; i < chamadas.length - 1; i++) {
      const diff = chamadas[i + 1].inicio - chamadas[i].inicio;
      assert.ok(
        diff >= minInterval - 5,
        `Intervalo entre chamadas ${i} e ${i + 1} foi ${diff}ms (< ${minInterval - 5}ms)`
      );
    }
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
