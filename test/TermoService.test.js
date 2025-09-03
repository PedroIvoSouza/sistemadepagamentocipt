import assert from 'assert';
import TermoService from '../src/services/TermoService.js';
import { ESPACOS_INFO } from '../src/config/espacos.js';

const template = `
<html>
  <head>
    <style>
      body { font-family: Arial; }
    </style>
  </head>
  <body>
    <p>Evento em {{data}} com valor de {{valor}}. Vigência: {{vigenciaInicio}} a {{vigenciaFim}}. Saldo: {{saldoPagamento}}. Cláusulas: {{clausulas}}.</p>
  </body>
</html>`;

const evento = {
  valor: 2495,
  dataRealizacaoInicio: '2025-08-12T03:00:00Z',
  dataRealizacaoFim: '2025-08-12T15:00:00Z',
  dataMontagem: '2025-08-10T03:00:00Z',
  dataDesmontagem: '2025-08-13T03:00:00Z',
  saldoPagamento: 3000,
  clausulas: ['Cláusula 1', 'Cláusula 2'],
  dars: [
    { dataVencimento: '2025-08-01T03:00:00Z' },
    { dataVencimento: '2025-08-20T03:00:00Z' }
  ]
};

const dados = TermoService.composeDataFromEvent(evento);
assert.strictEqual(dados.vigencia.inicio, evento.dataMontagem);
const vigenciaEsperada = new Date(evento.dataDesmontagem);
vigenciaEsperada.setDate(vigenciaEsperada.getDate() + 1);
assert.strictEqual(dados.vigencia.fim, vigenciaEsperada.toISOString());
assert.deepStrictEqual(dados.dars, evento.dars);

const resultado = TermoService.populateTemplate(template, dados);
assert.ok(resultado.includes('12 de agosto de 2025'));
assert.ok(resultado.includes('10 de agosto de 2025'));
assert.ok(resultado.includes('14 de agosto de 2025'));
assert.ok(resultado.includes('R$ 2.495,00'));

assert.deepStrictEqual(TermoService.getEspacoInfo('default'), ESPACOS_INFO.default);

(async () => {
  const pdf = await TermoService.generatePdf(template, dados);
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 0);

  let erroCapturado = false;
  try {
    await TermoService.generatePdf(template, { ...dados, saldoPagamento: 0 });
  } catch (err) {
    erroCapturado = true;
  }
  assert.ok(erroCapturado, 'Deve lançar erro quando não há saldo de pagamento');

  console.log('Todos os testes passaram.');
})();
