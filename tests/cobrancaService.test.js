const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { calcularEncargosAtraso } = require('../src/services/cobrancaService');

test('não calcula atraso quando o vencimento é hoje antes das 15h', async (t) => {
  const dar = {
    valor: 1000,
    data_vencimento: '2025-09-30'
  };

  const referencia = new Date('2025-09-30T14:00:00-03:00');

  const mockSelic = t.mock.method(axios, 'get', async () => {
    throw new Error('API SELIC não deve ser chamada quando não há atraso');
  });

  const resultado = await calcularEncargosAtraso(dar, referencia);

  assert.equal(resultado.diasAtraso, 0);
  assert.equal(resultado.valorAtualizado, dar.valor);
  assert.equal(resultado.novaDataVencimento, dar.data_vencimento);
  assert.equal(mockSelic.mock.callCount(), 0);
});

test('ajusta vencimento para o próximo dia útil após as 15h', async (t) => {
  const dar = {
    valor: 1000,
    data_vencimento: '2025-09-30'
  };

  const referencia = new Date('2025-09-30T16:00:00-03:00');

  const mockSelic = t.mock.method(axios, 'get', async () => ({ data: { valor: 12.5 } }));

  const resultado = await calcularEncargosAtraso(dar, referencia);

  assert.equal(mockSelic.mock.callCount(), 1);
  assert.equal(resultado.diasAtraso, 1);
  assert.equal(resultado.novaDataVencimento, '2025-10-01');
  assert(resultado.valorAtualizado > dar.valor);
});
