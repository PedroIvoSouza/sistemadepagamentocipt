import assert from 'assert';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { composeDataFromEvent, generateTermoPdf, getEspacoInfo } from '../src/services/termoEventoPdfkitService.js';
import { ESPACOS_INFO } from '../src/config/espacos.js';

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

const dados = composeDataFromEvent(evento);
assert.strictEqual(dados.vigencia.inicio, evento.dataMontagem);
const vigenciaEsperada = new Date(evento.dataDesmontagem);
vigenciaEsperada.setDate(vigenciaEsperada.getDate() + 1);
assert.strictEqual(dados.vigencia.fim, vigenciaEsperada.toISOString());
assert.deepStrictEqual(dados.dars, evento.dars);

assert.deepStrictEqual(getEspacoInfo('default'), ESPACOS_INFO.default);
assert.deepStrictEqual(getEspacoInfo('coworking'), ESPACOS_INFO.coworking);
assert.strictEqual(ESPACOS_INFO.coworking.nome, 'Coworking do Espaço de Fomento');
assert.strictEqual(ESPACOS_INFO.coworking.capacidade, 30);

(async () => {
  const token = 'TOKEN123';
  const pdf = await generateTermoPdf(dados, token);
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 0);

  const parsed = await pdfParse(pdf);
  const pdfText = parsed.text;
  const ocorrenciasToken = (pdfText.match(new RegExp(token, 'g')) || []).length;
  assert.strictEqual(ocorrenciasToken, 1, 'Token deve aparecer apenas uma vez');
  assert.ok(pdfText.includes('documento assinado eletronicamente'));
  assert.ok(pdfText.includes('PERMISSIONÁRIO'));

  let erroCapturado = false;
  try {
    await generateTermoPdf({ ...dados, saldoPagamento: 0 }, token);
  } catch (err) {
    erroCapturado = true;
  }
  assert.ok(erroCapturado, 'Deve lançar erro quando não há saldo de pagamento');

  console.log('Todos os testes passaram.');
})();
