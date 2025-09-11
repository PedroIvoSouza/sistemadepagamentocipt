const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

// Garantir variáveis de ambiente necessárias para execução do módulo.
process.env.SEFAZ_APP_TOKEN = process.env.SEFAZ_APP_TOKEN || 'test-token';

const servicePath = path.resolve(__dirname, '../src/services/assinafyService.js');

function loadService(getImpl) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'axios') {
      return { create: () => ({ get: getImpl }) };
    }
    if (request === 'form-data') {
      return function FormData() {};
    }
    if (request === 'sqlite3') {
      return { verbose: () => ({ Database: function () {} }) };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[servicePath];
  const svc = require(servicePath);
  Module._load = originalLoad;
  return svc;
}

test('getDocument retorna dados quando HTTP 200', async () => {
  const svc = loadService(async () => ({ status: 200, data: { id: '123', ok: true } }));
  const data = await svc.getDocument('123');
  assert.deepEqual(data, { id: '123', ok: true });
});

test('getDocument lança erro em HTTP não 2xx', async () => {
  const svc = loadService(async () => ({ status: 404, data: { error: 'nope' } }));
  await assert.rejects(() => svc.getDocument('x'), /HTTP 404/);
});

test('pickBestArtifactUrl seleciona URL em objetos', () => {
  const svc = loadService(async () => ({ status: 200, data: {} }));
  const doc = {
    artifacts: {
      certificated: 'https://example.com/cert',
      original: 'https://example.com/orig',
    },
  };
  assert.strictEqual(svc.pickBestArtifactUrl(doc), 'https://example.com/cert');
});

test('pickBestArtifactUrl seleciona URL em arrays', () => {
  const svc = loadService(async () => ({ status: 200, data: {} }));
  const doc = {
    artifacts: [
      { type: 'other', url: 'https://example.com/other' },
      { kind: 'certified', download_url: 'https://example.com/cert' },
    ],
  };
  assert.strictEqual(svc.pickBestArtifactUrl(doc), 'https://example.com/cert');
});

