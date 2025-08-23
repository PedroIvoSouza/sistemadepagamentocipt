const test = require('node:test');
const assert = require('node:assert');

const clientPath = require.resolve('../src/services/assinafyClient.js');

test('assinafyClient exige variáveis de ambiente', () => {
  const original = {
    ACCOUNT_ID: process.env.ASSINAFY_ACCOUNT_ID,
    API_KEY: process.env.ASSINAFY_API_KEY,
    ACCESS_TOKEN: process.env.ASSINAFY_ACCESS_TOKEN,
  };
  delete process.env.ASSINAFY_ACCOUNT_ID;
  delete process.env.ASSINAFY_API_KEY;
  delete process.env.ASSINAFY_ACCESS_TOKEN;
  delete require.cache[clientPath];
  assert.throws(() => require(clientPath), /ASSINAFY_ACCOUNT_ID/);
  if (original.ACCOUNT_ID !== undefined) process.env.ASSINAFY_ACCOUNT_ID = original.ACCOUNT_ID;
  if (original.API_KEY !== undefined) process.env.ASSINAFY_API_KEY = original.API_KEY;
  if (original.ACCESS_TOKEN !== undefined) process.env.ASSINAFY_ACCESS_TOKEN = original.ACCESS_TOKEN;
  delete require.cache[clientPath];
});

// Ensure fallback to official route when /self/embedded/sign returns 404

test('signVirtualDocuments falls back to sign-multiple when embedded route unavailable', async (t) => {
  process.env.ASSINAFY_ACCOUNT_ID = 'acc';
  process.env.ASSINAFY_API_KEY = 'key';
  delete process.env.ASSINAFY_ACCESS_TOKEN;
  delete require.cache[clientPath];

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

  const client = require(clientPath);
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
  delete require.cache[clientPath];
  delete process.env.ASSINAFY_ACCOUNT_ID;
  delete process.env.ASSINAFY_API_KEY;
});
