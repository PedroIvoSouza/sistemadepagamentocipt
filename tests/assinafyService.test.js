const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

// Garantir variáveis de ambiente necessárias para execução do módulo.
process.env.SEFAZ_APP_TOKEN = process.env.SEFAZ_APP_TOKEN || 'test-token';

const servicePath = path.resolve(__dirname, '../src/services/assinafyService.js');

function loadService(axiosHandlers) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'axios') {
      const handlers =
        typeof axiosHandlers === 'function'
          ? { get: axiosHandlers }
          : axiosHandlers || {};
      return { create: () => handlers };
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

test('ensureSigner sincroniza e-mail quando signatário existente está desatualizado', async () => {
  const calls = [];
  const svc = loadService({
    post: async (url, body) => {
      calls.push({ method: 'post', url, body });
      return { status: 400, data: { message: 'já existe um signatário com este e-mail.' } };
    },
    get: async (url, opts) => {
      calls.push({ method: 'get', url, params: opts?.params });
      return { status: 200, data: [{ id: 'sign-1', email: 'old@example.com', telephone: '+5511888888888' }] };
    },
    put: async (url, body) => {
      calls.push({ method: 'put', url, body });
      return { status: 200, data: { id: 'sign-1', email: body.email, telephone: body.telephone } };
    },
  });

  const signer = await svc.ensureSigner({
    full_name: 'Responsável',
    email: 'novo@example.com',
    government_id: '12345678900',
    phone: '+5511999999999',
  });

  assert.equal(signer.email, 'novo@example.com');
  assert.equal(signer.telephone, '+5511999999999');
  assert.equal(signer.full_name, 'Responsável');
  const putCalls = calls.filter((c) => c.method === 'put');
  assert.equal(putCalls.length, 1);
  assert.ok(putCalls[0].url.endsWith('/signers/sign-1'));
  assert.deepEqual(putCalls[0].body, {
    email: 'novo@example.com',
    telephone: '+5511999999999',
    full_name: 'Responsável',
  });
});

test('ensureSigner mantém e-mail existente quando novo valor está vazio', async () => {
  const calls = [];
  const svc = loadService({
    post: async (url, body) => {
      calls.push({ method: 'post', url, body });
      return { status: 400, data: { message: 'já existe um signatário com este e-mail.' } };
    },
    get: async (url, opts) => {
      calls.push({ method: 'get', url, params: opts?.params });
      if (opts?.params?.email !== undefined) {
        return { status: 200, data: [{ id: 'sign-2', email: 'old@example.com' }] };
      }
      return { status: 200, data: [] };
    },
  });

  const signer = await svc.ensureSigner({
    full_name: 'Responsável',
    email: '',
    government_id: '99988877766',
    phone: '+5511988887777',
  });

  assert.equal(signer.email, 'old@example.com');
  assert.equal(signer.full_name, 'Responsável');
  assert.equal(calls.filter((c) => c.method === 'put').length, 0);
});

test('ensureSigner sincroniza nome quando signatário existe mas nome diverge', async () => {
  const calls = [];
  const svc = loadService({
    post: async (url, body) => {
      calls.push({ method: 'post', url, body });
      return { status: 400, data: { message: 'já existe um signatário com este e-mail.' } };
    },
    get: async (url, opts) => {
      calls.push({ method: 'get', url, params: opts?.params });
      return {
        status: 200,
        data: [
          { id: 'sign-3', email: 'mesmo@example.com', telephone: '+5511777777777', full_name: 'Nome Antigo' },
        ],
      };
    },
    put: async (url, body) => {
      calls.push({ method: 'put', url, body });
      return { status: 200, data: { id: 'sign-3', ...body } };
    },
  });

  const signer = await svc.ensureSigner({
    full_name: '  Nome Novo  ',
    email: 'mesmo@example.com',
    government_id: '11122233344',
    phone: '+5511666666666',
  });

  assert.equal(signer.full_name, 'Nome Novo');
  assert.equal(signer.email, 'mesmo@example.com');
  assert.equal(signer.telephone, '+5511666666666');
  const putCalls = calls.filter((c) => c.method === 'put');
  assert.equal(putCalls.length, 1);
  assert.ok(putCalls[0].url.endsWith('/signers/sign-3'));
  assert.deepEqual(putCalls[0].body, {
    telephone: '+5511666666666',
    full_name: 'Nome Novo',
  });
});

