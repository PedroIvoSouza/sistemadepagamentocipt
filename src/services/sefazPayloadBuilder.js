// src/services/sefazPayloadBuilder.js
const { VERSAO_GUIA, CODIGO_IBGE_MUNICIPIO_DEFAULT, RECEITA_CODIGO_EVENTO } = require('../config/sefaz');

// util: só dígitos
const digits = s => (s || '').toString().replace(/\D+/g, '');
// util: 3=CPF, 4=CNPJ
const docType = doc => (digits(doc).length === 11 ? 3 : 4);

// derive { mes, ano } a partir de 'YYYY-MM-DD' (ou 'DD/MM/YYYY')
function competenciaFromDate(dateStr) {
  if (!dateStr) return { mes: null, ano: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y,m] = dateStr.split('-');
    return { mes: Number(m), ano: Number(y) };
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [d,m,y] = dateStr.split('/');
    return { mes: Number(m), ano: Number(y) };
  }
  const d = new Date(dateStr);
  return { mes: d.getMonth() + 1, ano: d.getFullYear() };
}

// principal builder
function buildSefazPayloadFromDarEvento({ darRow, eventoRow, clienteRow, receitaCodigo, dataLimite }) {
  const receita = (receitaCodigo || RECEITA_CODIGO_EVENTO || '').toString().replace(/\D+/g, '');
  const dataVencimento = darRow?.data_vencimento || darRow?.dar_venc; // colunas que você usa nos SELECTs
  const { mes, ano } = competenciaFromDate(dataVencimento);

  const extras = [
    eventoRow?.hora_montagem ? `Montagem ${eventoRow.hora_montagem}` : null,
    eventoRow?.hora_inicio && eventoRow?.hora_fim ? `Evento ${eventoRow.hora_inicio}-${eventoRow.hora_fim}` : null,
    eventoRow?.hora_desmontagem ? `Desmontagem ${eventoRow.hora_desmontagem}` : null
  ].filter(Boolean).join(' | ');

  return {
    versao: VERSAO_GUIA,
    dataLimitePagamento: dataLimite || dataVencimento, // regra simples: igual ao vencimento da parcela
    observacao: `Pagamento referente ao evento: ${eventoRow?.nome_evento || 'Evento'}${extras ? ' (' + extras + ')' : ''}`,
    contribuinteEmitente: {
      codigoTipoInscricao: docType(clienteRow?.documento), // 3=CPF, 4=CNPJ
      numeroInscricao: digits(clienteRow?.documento),
      nome: clienteRow?.nome_razao_social || '',
      codigoIbgeMunicipio: clienteRow?.codigo_ibge_municipio || CODIGO_IBGE_MUNICIPIO_DEFAULT,
      numeroCep: digits(clienteRow?.cep || ''),
      descricaoEndereco: clienteRow?.endereco || '',
    },
    receitas: [
      {
        codigo: receita, // sem dígito
        competencia: { mes, ano },
        valorPrincipal: Number(darRow?.valor ?? darRow?.dar_valor ?? 0),
        valorDesconto: 0,
        dataVencimento: dataVencimento,
        // Se a receita exigir documento de origem, preencher aqui:
        // codigoTipoDocumentoOrigem, numeroDocumentoOrigem
      }
    ]
  };
}

module.exports = { buildSefazPayloadFromDarEvento };