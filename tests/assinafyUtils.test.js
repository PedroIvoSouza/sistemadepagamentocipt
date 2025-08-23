const test = require('node:test');
const assert = require('node:assert');

const { scanForSigningUrl } = require('../src/services/assinafyUtils');

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
