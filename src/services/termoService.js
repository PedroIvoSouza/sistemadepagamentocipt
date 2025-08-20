const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

async function gerarTermoPermissao(evento, parcelas = []) {
  const templatePath = path.join(__dirname, '..', 'assets', 'termo_permissao_modelo.pdf');
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const draw = (text, x, y, options = {}) => {
    page.drawText(text ?? '', { x, y, size: 12, font, ...options });
  };

  draw(`Processo: ${evento.numero_processo || ''}`, 50, 750);
  draw(`Termo: ${evento.numero_termo || ''}`, 350, 750);

  const cliente = `${evento.nome_razao_social || ''} - ${evento.documento || ''}`;
  draw(cliente, 50, 730);

  const datas = Array.isArray(evento.datas_evento)
    ? evento.datas_evento.join(', ')
    : String(evento.datas_evento || '');

  const clausula1 =
    `Área: ${evento.area_m2 || '-'} m², Evento: ${evento.nome_evento || '-'}, Datas: ${datas}, ` +
    `Horário: ${evento.hora_inicio || '-'}-${evento.hora_fim || '-'}, Ofício SEI: ${evento.numero_oficio_sei || '-'}`;
  draw(clausula1, 50, 700, { maxWidth: 500, lineHeight: 14 });

  draw('Área', 60, 640);
  draw(String(evento.area_m2 || '-'), 200, 640);
  draw(String(evento.total_diarias || '-'), 300, 640);
  const valorFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    Number(evento.valor_final) || 0
  );
  draw(valorFmt, 400, 640);

  const vigencia = evento.data_vigencia_final
    ? new Date(evento.data_vigencia_final + 'T00:00:00').toLocaleDateString('pt-BR')
    : '-';
  draw(`Vigência até ${vigencia}`, 50, 610, { maxWidth: 500, lineHeight: 14 });

  if (parcelas.length) {
    const partes = parcelas.map(
      p => `${p.numero_parcela}ª parcela em ${new Date(p.data_vencimento + 'T00:00:00').toLocaleDateString('pt-BR')} - ` +
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(p.valor_parcela) || 0)
    );
    draw('Pagamentos: ' + partes.join('; '), 50, 580, { maxWidth: 500, lineHeight: 14 });
  }

  const dataDoc = new Date().toLocaleDateString('pt-BR');
  draw(`Maceió, ${dataDoc}`, 50, 520);

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

module.exports = { gerarTermoPermissao };
