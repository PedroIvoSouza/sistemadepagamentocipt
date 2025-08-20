const assert = require('assert');
const TermoService = require('../src/services/TermoService');

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
const dados = {
  data: '2025-08-12',
  valor: 2495,
  vigencia: { inicio: '2025-01-01', fim: '2025-12-31' },
  saldoPagamento: 3000,
  clausulas: ['Cláusula 1', 'Cláusula 2']
};

const resultado = TermoService.populateTemplate(template, dados);
assert.ok(resultado.includes('12 de agosto de 2025'));
assert.ok(resultado.includes('R$ 2.495,00'));

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
