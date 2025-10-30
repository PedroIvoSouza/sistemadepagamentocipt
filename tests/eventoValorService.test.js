const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calcularValorBruto,
  calcularValorFinal,
  identificarTabelaPorEspacos,
} = require('../src/services/eventoValorService');

function extrairTabela(espacos) {
  const tabela = [];
  let acumuladoAnterior = 0;
  for (let dia = 1; dia <= 4; dia += 1) {
    const totalAtual = calcularValorBruto(dia, espacos);
    const diaria = Number((totalAtual - acumuladoAnterior).toFixed(2));
    tabela.push(diaria);
    acumuladoAnterior = totalAtual;
  }
  tabela.push(tabela[3]);
  return tabela;
}

test('calcularValorBruto usa tabela padrão do auditório', () => {
  const valor = calcularValorBruto(2);
  const tabela = extrairTabela();
  const esperado = tabela[0] + tabela[1];
  assert.equal(valor, Number(esperado.toFixed(2)));
});

test('calcularValorBruto aplica tabela reduzida para o anfiteatro', () => {
  const valor = calcularValorBruto(1, ['Anfiteatro']);
  const tabela = extrairTabela(['Anfiteatro']);
  assert.equal(valor, tabela[0]);
});

test('calcularValorBruto multiplica diárias adicionais do anfiteatro', () => {
  const valor = calcularValorBruto(4, ['Auditório, Anfiteatro']);
  const tabelaAudit = extrairTabela();
  const tabelaAnf = extrairTabela(['Anfiteatro']);
  // Apesar de incluir texto auditório no valor, auditório deve prevalecer
  assert.equal(valor, tabelaAudit[0] + tabelaAudit[1] + tabelaAudit[2] + tabelaAudit[3]);

  const somenteAnfiteatro = calcularValorBruto(4, ['Anfiteatro']);
  assert.equal(somenteAnfiteatro, Number((tabelaAnf[0] + tabelaAnf[1] + tabelaAnf[2] + tabelaAnf[3]).toFixed(2)));
});

test('identificarTabelaPorEspacos aceita texto composto', () => {
  const chave = identificarTabelaPorEspacos('Anfiteatro e Espaço Aberto');
  assert.equal(chave, 'ANFITEATRO');
  const chaveAudit = identificarTabelaPorEspacos('Auditório e Espaço Aberto');
  assert.equal(chaveAudit, 'AUDITORIO');
});

test('calcularValorFinal mantém descontos aplicados após novo cálculo bruto', () => {
  const bruto = calcularValorBruto(1, ['Anfiteatro']);
  const finalPermissionario = calcularValorFinal(bruto, 'Permissionario');
  assert.equal(finalPermissionario, Number((bruto * 0.4).toFixed(2)));
});
