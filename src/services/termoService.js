const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

function formatCurrency(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

const formatadorData = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'long',
  year: 'numeric'
});

function formatDate(data) {
  if (!data) return '';
  const d = new Date(data);
  if (isNaN(d)) return '';
  return formatadorData.format(d);
}

async function gerarTermoPermissao(evento = {}, parcelas = []) {
  const templatePath = path.join(
    __dirname,
    '..',
    'assets',
    'termo_permissao_modelo.pdf'
  );
  let template = fs.readFileSync(templatePath, 'binary');

  const datas = Array.isArray(evento.datas_evento)
    ? evento.datas_evento.join(', ')
    : String(evento.datas_evento || '');

  const tabelaLinha = `${evento.area_m2 || '-'};${
    evento.total_diarias || '-'
  };${formatCurrency(evento.valor_final)}`;

  const cronograma = parcelas
    .map(
      p =>
        `${p.numero_parcela}ª parcela em ${formatDate(p.data_vencimento)} - ${formatCurrency(
          p.valor_parcela
        )}`
    )
    .join('; ');

  const replacements = {
    numero_processo: evento.numero_processo || '',
    numero_termo: evento.numero_termo || '',
    permissionario_nome: evento.nome_razao_social || '',
    permissionario_documento: evento.documento || '',
    clausula1:
      `Área: ${evento.area_m2 || '-'} m², Evento: ${
        evento.nome_evento || '-'
      }, Datas: ${datas}, Horário: ${evento.hora_inicio || '-'}-${
        evento.hora_fim || '-'
      }, Ofício SEI: ${evento.numero_oficio_sei || '-'}`,
    tabela_linha: tabelaLinha,
    pagamentos: cronograma,
    vigencia_fim_datahora: formatDate(
      evento.vigencia_fim_datahora || evento.data_vigencia_final
    ),
    pagto_sinal_data: formatDate(evento.pagto_sinal_data),
    pagto_saldo_data: formatDate(evento.pagto_saldo_data),
    assinatura_data: formatDate(new Date())
  };

  template = template.replace(/{{\s*([\w_]+)\s*}}/g, (match, key) => {
    const value = Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key])
      : '';
    return value.padEnd(match.length, ' ');
  });
  const pdfBuffer = Buffer.from(template, 'binary');
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
    return pdfBytes;
  } catch (err) {
    return pdfBuffer;
  }
}

module.exports = { gerarTermoPermissao, formatCurrency, formatDate };
