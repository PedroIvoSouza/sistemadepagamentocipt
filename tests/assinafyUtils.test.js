const test = require('node:test');
const assert = require('node:assert');

const { scanForSigningUrl, normalizeAssinafyStatus } = require('../src/services/assinafyUtils');

// Evita dependências não instaladas ao importar o serviço completo.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'sqlite3') {
    return { verbose: () => ({ Database: function () {} }) };
  }
  if (request === 'axios') {
    return { create: () => ({ get() {}, post() {}, put() {} }) };
  }
  if (request === 'form-data') return function FormData() {};
  return originalLoad(request, parent, isMain);
};
const { pickBestArtifactUrl } = require('../src/services/assinafyService');
Module._load = originalLoad;

test('retorna URL direta', () => {
  const obj = { signer_url: 'https://example.com/a' };
  assert.strictEqual(scanForSigningUrl(obj), 'https://example.com/a');
});

test('normaliza link /verify/', () => {
  const obj = { link: '/verify/abc123' };
  assert.strictEqual(
    scanForSigningUrl(obj),
    'https://app.assinafy.com.br/verify/abc123'
  );
});

test('procura em arrays de assignments', () => {
  const obj = { assignments: [ { signUrl: 'https://example.com/arr' } ] };
  assert.strictEqual(scanForSigningUrl(obj), 'https://example.com/arr');
});

test('varre propriedades aninhadas com sign/assign', () => {
  const obj = { level1: { someSign: { url: 'https://example.com/deep' } } };
  assert.strictEqual(scanForSigningUrl(obj), 'https://example.com/deep');
});

test('retorna null quando ausente', () => {
  assert.strictEqual(scanForSigningUrl({ foo: 'bar' }), null);
});

test('normalizeAssinafyStatus unifica valores assinados', () => {
  assert.strictEqual(normalizeAssinafyStatus('SIGNED', false), 'assinado');
  assert.strictEqual(normalizeAssinafyStatus('assinado', false), 'assinado');
  assert.strictEqual(normalizeAssinafyStatus('completed', false), 'assinado');
});

test('normalizeAssinafyStatus lida com PDF assinado', () => {
  assert.strictEqual(normalizeAssinafyStatus('qualquer', true), 'assinado');
});

test('normalizeAssinafyStatus devolve status lower-case ou "gerado"', () => {
  assert.strictEqual(normalizeAssinafyStatus('PendEntE_Assinatura', false), 'pendente_assinatura');
  assert.strictEqual(normalizeAssinafyStatus(undefined, false), 'gerado');
});

test('pickBestArtifactUrl lida com artifacts em objeto', () => {
  const doc = { artifacts: { certificated: 'https://example.com/cert', original: 'https://example.com/orig' } };
  assert.strictEqual(pickBestArtifactUrl(doc), 'https://example.com/cert');
});

test('pickBestArtifactUrl lida com artifacts em array', () => {
  const doc = {
    artifacts: [
      { type: 'other', url: 'https://example.com/other' },
      { kind: 'certified', url: 'https://example.com/cert' },
    ],
  };
  assert.strictEqual(pickBestArtifactUrl(doc), 'https://example.com/cert');
});
