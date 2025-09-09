import assert from 'assert';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { composeDataFromEvent, generateTermoPdf, getEspacoInfo, buildClausula4Paragrafo, CLAUSULAS_TERMO } from '../src/services/termoEventoPdfkitService.js';
import { ESPACOS_INFO } from '../src/config/espacos.js';

const eventoBase = {
  valor: 2495,
  dataRealizacaoInicio: '2025-08-12T03:00:00Z',
  dataRealizacaoFim: '2025-08-12T15:00:00Z',
  dataMontagem: '2025-08-10T03:00:00Z',
  dataDesmontagem: '2025-08-13T03:00:00Z',
  saldoPagamento: 3000,
  clausulas: ['5.19', '5.20'],
  dars: [
    { dataVencimento: '2025-08-01T03:00:00Z' },
    { dataVencimento: '2025-08-20T03:00:00Z' }
  ]
};

assert.deepStrictEqual(getEspacoInfo('default'), ESPACOS_INFO.default);
assert.deepStrictEqual(getEspacoInfo('coworking'), ESPACOS_INFO.coworking);
assert.strictEqual(ESPACOS_INFO.coworking.nome, 'Coworking do Espaço de Fomento');
assert.strictEqual(ESPACOS_INFO.coworking.capacidade, 30);

(async () => {
  const token = 'TOKEN123';
  const combinacoes = [
    {
      espacos: ['default'],
      clausula: 'Cláusula 4 - Parágrafo Único: Espaços envolvidos: Espaço Principal.'
    },
    {
      espacos: ['default', 'coworking'],
      clausula: 'Cláusula 4 - Parágrafo Único: Espaços envolvidos: Espaço Principal e Coworking do Espaço de Fomento.'
    }
  ];

  for (const [index, combo] of combinacoes.entries()) {
    const dados = composeDataFromEvent({ ...eventoBase, espacos: combo.espacos });
    assert.deepStrictEqual(dados.espacos, combo.espacos);
    assert.ok(dados.clausulas.includes(CLAUSULAS_TERMO['5.19']));
    assert.ok(dados.clausulas.includes(CLAUSULAS_TERMO['5.20']));

    if (index === 0) {
      assert.strictEqual(dados.vigencia.inicio, eventoBase.dataMontagem);
      const vigenciaEsperada = new Date(eventoBase.dataDesmontagem);
      vigenciaEsperada.setDate(vigenciaEsperada.getDate() + 1);
      assert.strictEqual(dados.vigencia.fim, vigenciaEsperada.toISOString());
      assert.deepStrictEqual(dados.dars, eventoBase.dars);
    }

    const pdf = await generateTermoPdf(dados, token);
    assert.ok(Buffer.isBuffer(pdf) && pdf.length > 0);
    const parsed = await pdfParse(pdf);
    const texto = parsed.text.replace(/\s+/g, ' ');
    assert.ok(texto.includes(CLAUSULAS_TERMO['5.19']));
    assert.ok(texto.includes(CLAUSULAS_TERMO['5.20']));

    const clausula = buildClausula4Paragrafo(dados.espacos);
    assert.strictEqual(clausula, combo.clausula);
  }

  let erroCapturado = false;
  try {
    const dados = composeDataFromEvent({ ...eventoBase, espacos: ['default'] });
    await generateTermoPdf({ ...dados, saldoPagamento: 0 }, token);
  } catch (err) {
    erroCapturado = true;
  }
  assert.ok(erroCapturado, 'Deve lançar erro quando não há saldo de pagamento');

  console.log('Todos os testes passaram.');
})();
