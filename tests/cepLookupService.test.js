const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const servicePath = path.resolve(__dirname, '../src/services/cepLookupService.js');

function mockAxios(responseImpl) {
  const axiosPath = require.resolve('axios');
  const original = require.cache[axiosPath];
  require.cache[axiosPath] = { exports: { get: responseImpl } };
  delete require.cache[servicePath];
  const svc = require(servicePath);
  return { ...svc, restore: () => { require.cache[axiosPath] = original; } };
}

test('fetchCepAddress retorna dados mapeados', async () => {
  const { fetchCepAddress, restore } = mockAxios(async () => ({
    data: {
      logradouro: 'Rua X',
      bairro: 'Bairro Y',
      localidade: 'Cidade Z',
      uf: 'SP'
    }
  }));
  const data = await fetchCepAddress('12345-678');
  assert.deepEqual(data, {
    logradouro: 'Rua X',
    bairro: 'Bairro Y',
    localidade: 'Cidade Z',
    uf: 'SP'
  });
  restore();
});

test('fetchCepAddress lança erro para 404', async () => {
  const { fetchCepAddress, restore } = mockAxios(async () => {
    const err = new Error('not found');
    err.response = { status: 404 };
    throw err;
  });
  await assert.rejects(() => fetchCepAddress('12345678'), /não encontrado/);
  restore();
});

test('fetchCepAddress valida CEP com 8 dígitos', async () => {
  const { fetchCepAddress, restore } = mockAxios(async () => ({ data: {} }));
  await assert.rejects(() => fetchCepAddress('1234'), /CEP inválido/);
  restore();
});

