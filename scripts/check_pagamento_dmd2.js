require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

const norm = s => String(s || '').replace(/\D/g, '');

async function main() {
  const CNPJ = '09584747000109';      // DMD2
  const VALOR_CENTS = Math.round(1276.80 * 100);
  const DIA = '2025-08-15';           // data_pagamento que ficou na DAR ID 5

  // pega por arrecadação e por inclusão do mesmo dia
  const porArrec = await listarPagamentosPorDataArrecadacao(DIA, DIA);
  const porIncl  = await listarPagamentosPorDataInclusao(`${DIA} 00:00:00`, `${DIA} 23:59:59`);
  const todos = [...porArrec, ...porIncl];

  // filtra pagamentos exatamente do CNPJ da DMD2 e valor 1276,80
  const matches = todos.filter(p =>
    norm(p.numeroInscricao) === CNPJ &&
    Math.round(Number(p.valorPago) * 100) === VALOR_CENTS
  );

  // mostra os campos que comprovam o pagamento
  console.log(
    matches.map(p => ({
      numeroGuia: p.numeroGuia || null,
      codigoBarras: p.codigoBarras || p.linhaDigitavel || null,
      numeroInscricao: p.numeroInscricao,
      valorPago: p.valorPago,
      dataPagamento: p.dataPagamento || p.dataArrecadacao || null,
      origem: p.origem || null
    }))
  );

  if (matches.length === 0) {
    console.log('Nenhum pagamento da DMD2 com esse valor nessa data.');
  }
}

main().catch(console.error);
