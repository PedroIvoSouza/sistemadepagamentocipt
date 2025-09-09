import PDFDocument from 'pdfkit';
import { ESPACOS_INFO } from '../config/espacos.js';

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value).replace(/\u00A0/g, ' ');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo'
  }).format(new Date(date));
}

export function composeDataFromEvent(evento) {
  const vigenciaFim = new Date(evento.dataDesmontagem);
  vigenciaFim.setDate(vigenciaFim.getDate() + 1);
  return {
    valor: evento.valor,
    data: evento.dataRealizacaoInicio,
    vigencia: {
      inicio: evento.dataMontagem,
      fim: vigenciaFim.toISOString()
    },
    saldoPagamento: evento.saldoPagamento,
    clausulas: evento.clausulas,
    dars: Array.isArray(evento.dars) ? evento.dars.map(d => ({ ...d })) : []
  };
}

function buildDescription(data) {
  const clausulas = Array.isArray(data.clausulas) ? data.clausulas.join('; ') : '';
  return `Evento em ${formatDate(data.data)} com valor de ${formatCurrency(data.valor)}. Vigência: ${formatDate(data.vigencia.inicio)} a ${formatDate(data.vigencia.fim)}. Saldo: ${formatCurrency(data.saldoPagamento)}. Cláusulas: ${clausulas}.`;
}

export async function generateTermoPdf(data, token = '') {
  if (typeof data.saldoPagamento !== 'number' || data.saldoPagamento <= 0) {
    throw new Error('Saldo de pagamento insuficiente.');
  }
  if (!data.vigencia || !data.vigencia.inicio || !data.vigencia.fim) {
    throw new Error('Período de vigência inválido.');
  }
  if (!Array.isArray(data.clausulas) || data.clausulas.length === 0) {
    throw new Error('Cláusulas específicas não informadas.');
  }

  const descricao = buildDescription(data);
  const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false });
  return new Promise((resolve, reject) => {
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Conteúdo principal
    doc.font('Helvetica').fontSize(12).text(descricao, { align: 'left' });

    // Página final com assinaturas
    doc.addPage();
    const center = { align: 'center' };
    doc.font('Helvetica').fontSize(12).text('documento assinado eletronicamente', center);
    doc.text('SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS', center);
    doc.moveDown();
    doc.text('PERMISSIONÁRIO', center);
    if (token) {
      const cm = 28.3465; // pontos por centímetro
      const yToken = doc.y + 2 * cm;
      doc.text(token, 0, yToken, center);
    }

    doc.end();
  });
}

export function getEspacoInfo(nome) {
  return ESPACOS_INFO[nome];
}
