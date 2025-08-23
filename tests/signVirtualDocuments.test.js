const test = require('node:test');
const assert = require('node:assert');

// Ensure fallback to official route when /self/embedded/sign returns 404

test('signVirtualDocuments falls back to sign-multiple when embedded route unavailable', async (t) => {
  const axios = require('axios');
  const calls = [];

  t.mock.method(axios, 'create', () => ({
    put: async (url, body) => {
      calls.push({ url, body });
      if (url === '/self/embedded/sign') {
        return { status: 404, data: { message: 'not found' } };
      }
      return { status: 200, data: { ok: true, url, body } };
    },
  }));

  const client = require('../src/services/assinafyClient.js');
  const res = await client.signVirtualDocuments('CODE123', ['doc1', 'doc2']);

  assert.deepStrictEqual(res, {
    ok: true,
    url: '/signers/documents/sign-multiple?signer_access_code=CODE123',
    body: { document_ids: ['doc1', 'doc2'] },
  });

  assert.deepStrictEqual(calls, [
    {
      url: '/self/embedded/sign',
      body: { signer_access_code: 'CODE123', document_ids: ['doc1', 'doc2'] },
    },
    {
      url: '/signers/documents/sign-multiple?signer_access_code=CODE123',
      body: { document_ids: ['doc1', 'doc2'] },
    },
  ]);

  t.mock.restoreAll();
  delete require.cache[require.resolve('../src/services/assinafyClient.js')];
});
