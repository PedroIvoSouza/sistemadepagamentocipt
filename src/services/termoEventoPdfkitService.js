import PDFDocument from 'pdfkit';
import { ESPACOS_INFO } from '../config/espacos.js';
import NotificationService from './NotificationService.js';

export const CLAUSULAS_TERMO = {
  '5.19': 'Cláusula 5.19 - O permissionário deverá utilizar os espaços somente para os fins autorizados, responsabilizando-se pela integridade dos bens públicos.',
  '5.20': 'Cláusula 5.20 - Após o término do evento, o permissionário compromete-se a devolver os espaços nas mesmas condições em que os recebeu, respondendo por eventuais danos.'
};

function resolveClausulas(clausulas = []) {
  return Array.isArray(clausulas) ? clausulas.map(c => CLAUSULAS_TERMO[c] || c) : [];
}

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
    espacos: Array.isArray(evento.espacos) ? [...evento.espacos] : [],
    vigencia: {
      inicio: evento.dataMontagem,
      fim: vigenciaFim.toISOString()
    },
    saldoPagamento: evento.saldoPagamento,
    clausulas: resolveClausulas(evento.clausulas),
    dars: Array.isArray(evento.dars) ? evento.dars.map(d => ({ ...d })) : []
  };
}

export function buildClausula4Paragrafo(espacos = []) {
  if (!Array.isArray(espacos) || espacos.length === 0) {
    return '';
  }
  const nomes = espacos.map(e => ESPACOS_INFO[e]?.nome || e);
  const lista = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0];
  return `Cláusula 4 - Parágrafo Único: Espaços envolvidos: ${lista}.`;
}

function buildDescription(data) {
  const clausulas = Array.isArray(data.clausulas) ? data.clausulas.join('; ') : '';
  const clausula4 = buildClausula4Paragrafo(data.espacos);
  const base = `Evento em ${formatDate(data.data)} com valor de ${formatCurrency(data.valor)}. Vigência: ${formatDate(data.vigencia.inicio)} a ${formatDate(data.vigencia.fim)}. Saldo: ${formatCurrency(data.saldoPagamento)}. Cláusulas: ${clausulas}.`;
  return clausula4 ? `${base} ${clausula4}` : base;
}

export async function generateTermoPdf(data, token = '') {
  const dados = { ...data, clausulas: resolveClausulas(data.clausulas) };

  if (typeof dados.saldoPagamento !== 'number' || dados.saldoPagamento <= 0) {
    throw new Error('Saldo de pagamento insuficiente.');
  }
  if (!dados.vigencia || !dados.vigencia.inicio || !dados.vigencia.fim) {
    throw new Error('Período de vigência inválido.');
  }
  if (!Array.isArray(dados.clausulas) || dados.clausulas.length === 0) {
    throw new Error('Cláusulas específicas não informadas.');
  }

  const descricao = buildDescription(dados);
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

export async function enviarTermoParaAssinatura(dados, token, nomeCliente, numeroTermo, nomeEvento, email) {
  const pdf = await generateTermoPdf(dados, token);
  await NotificationService.sendTermoEnviado(nomeCliente, numeroTermo, nomeEvento, email);
  return pdf;
}

export function getEspacoInfo(nome) {
  return ESPACOS_INFO[nome];
}
