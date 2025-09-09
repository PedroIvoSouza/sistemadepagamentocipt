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

export async function generateTermoPdf(data) {
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
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  return new Promise((resolve, reject) => {
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.font('Helvetica').fontSize(12).text(descricao, { align: 'left' });

    doc.end();
  });
}

export function getEspacoInfo(nome) {
  return ESPACOS_INFO[nome];
}
