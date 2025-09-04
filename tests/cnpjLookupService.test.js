const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const servicePath = path.resolve(__dirname, '../src/services/cnpjLookupService.js');

function mockAxios(responseImpl) {
  const axiosPath = require.resolve('axios');
  const original = require.cache[axiosPath];
  require.cache[axiosPath] = { exports: { get: responseImpl } };
  delete require.cache[servicePath];
  const svc = require(servicePath);
  return { ...svc, restore: () => { require.cache[axiosPath] = original; } };
}

test('fetchCnpjData retorna dados mapeados', async () => {
  const { fetchCnpjData, restore } = mockAxios(async () => ({
    data: {
      razao_social: 'Empresa RS',
      nome_fantasia: 'Fantasia',
      logradouro: 'Rua A',
      bairro: 'Bairro B',
      municipio: 'Cidade C',
      uf: 'SP',
      cep: '12345678'
    }
  }));
  const data = await fetchCnpjData('12.345.678/0001-00');
  assert.deepEqual(data, {
    razao_social: 'Empresa RS',
    nome_fantasia: 'Fantasia',
    logradouro: 'Rua A',
    bairro: 'Bairro B',
    cidade: 'Cidade C',
    uf: 'SP',
    cep: '12345678'
  });
  restore();
});

test('fetchCnpjData retorna null para 404', async () => {
  const { fetchCnpjData, restore } = mockAxios(async () => {
    const err = new Error('not found');
    err.response = { status: 404 };
    throw err;
  });
  const data = await fetchCnpjData('00');
  assert.equal(data, null);
  restore();
});

test('fetchCnpjData propaga outros erros', async () => {
  const { fetchCnpjData, restore } = mockAxios(async () => {
    const err = new Error('fail');
    err.response = { status: 500 };
    throw err;
  });
  await assert.rejects(() => fetchCnpjData('00'), /fail/);
  restore();
});
