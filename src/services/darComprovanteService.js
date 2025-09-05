const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');

const { consultarPagamentoPorCodigoBarras, listarPagamentosPorDataArrecadacao } = require('./sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { applyLetterhead, abntMargins, cm } = require('../utils/pdfLetterhead');
const { isoHojeLocal, toISO } = require('../utils/sefazPayload');
const { BUSCA_PAGAMENTO_MAX_DIAS } = require('../config/dars');
const { atualizarDataPagamento } = require('./darService');

async function gerarComprovante(darId, db, { reuseExisting = true } = {}) {
  // Helpers using provided db
  const dbGetAsync = (sql, params = []) =>
    new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const dbRunAsync = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));

  const dar = await dbGetAsync(
    `SELECT d.*, p.nome_empresa, p.cnpj, p.id AS perm_id
       FROM dars d
       LEFT JOIN permissionarios p ON p.id = d.permissionario_id
      WHERE d.id = ?`,
    [darId]
  );
  if (!dar) {
    const err = new Error('DAR não encontrado.');
    err.status = 404;
    throw err;
  }

  if (reuseExisting && dar.comprovante_token) {
    try {
      const docRow = await dbGetAsync(`SELECT caminho FROM documentos WHERE token = ?`, [dar.comprovante_token]);
      if (docRow?.caminho && fs.existsSync(docRow.caminho)) {
        const buffer = fs.readFileSync(docRow.caminho);
        return { buffer, token: dar.comprovante_token, filePath: docRow.caminho, reused: true };
      }
    } catch (e) {
      console.warn('[darComprovanteService] Falha ao recuperar comprovante existente:', e.message);
    }
  }

  const numeroGuia = String(dar.numero_documento || '').trim();
  const ld = dar.linha_digitavel || dar.codigo_barras || '';

  let pagamento;
  try {
    pagamento = await consultarPagamentoPorCodigoBarras(numeroGuia, ld);
  } catch (e) {
    console.warn('[darComprovanteService] Falha lookup direto na SEFAZ:', e.message);
  }

  if (!pagamento) {
    const inicioISO = toISO(dar.data_vencimento) || isoHojeLocal();
    const inicio = new Date(inicioISO);
    const hoje = new Date(isoHojeLocal());
    const msDia = 24 * 60 * 60 * 1000;
    let diasFrente = Math.floor((hoje - inicio) / msDia) + 1;
    if (diasFrente < 1) diasFrente = 1;
    const limiteFrente = Math.min(BUSCA_PAGAMENTO_MAX_DIAS, diasFrente);
    const limiteTras = BUSCA_PAGAMENTO_MAX_DIAS;
    const maxOffset = Math.max(limiteFrente, limiteTras) + 1;

    for (let i = 0; i < maxOffset && !pagamento; i++) {
      if (i < limiteFrente) {
        const dia = new Date(inicio);
        dia.setDate(inicio.getDate() + i);
        const diaISO = toISO(dia);
        try {
          const lista = await listarPagamentosPorDataArrecadacao(diaISO, diaISO);
          pagamento = lista.find(
            (p) =>
              p.numeroGuia === numeroGuia ||
              (dar.codigo_barras && p.codigoBarras === dar.codigo_barras) ||
              (dar.linha_digitavel && p.linhaDigitavel === dar.linha_digitavel)
          );
        } catch (e) {
          console.warn('[darComprovanteService] Falha ao consultar pagamento na SEFAZ:', e.message);
        }
      }
      if (!pagamento && i > 0 && i <= limiteTras) {
        const dia = new Date(inicio);
        dia.setDate(inicio.getDate() - i);
        const diaISO = toISO(dia);
        try {
          const lista = await listarPagamentosPorDataArrecadacao(diaISO, diaISO);
          pagamento = lista.find(
            (p) =>
              p.numeroGuia === numeroGuia ||
              (dar.codigo_barras && p.codigoBarras === dar.codigo_barras) ||
              (dar.linha_digitavel && p.linhaDigitavel === dar.linha_digitavel)
          );
        } catch (e) {
          console.warn('[darComprovanteService] Falha ao consultar pagamento na SEFAZ:', e.message);
        }
      }
    }
  }

  if (!pagamento) {
    const err = new Error('Pagamento não localizado na SEFAZ.');
    err.status = 404;
    throw err;
  }

  const dataPgISO = toISO(pagamento.dataPagamento);
  if (dataPgISO) {
    try {
      await atualizarDataPagamento(darId, dataPgISO);
    } catch (e) {
      console.warn('[darComprovanteService] Falha ao persistir data_pagamento:', e.message);
    }
  }

  const tokenDoc = await gerarTokenDocumento('DAR_COMPROVANTE', dar.permissionario_id, db);

  const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5, 2) });
  applyLetterhead(doc);

  const chunks = [];
  let tokenYFromBottom = 0;
  doc.on('data', (c) => chunks.push(c));

  const endPromise = new Promise((resolve, reject) => {
    doc.on('end', async () => {
      try {
        const pdfBuffer = Buffer.concat(chunks);
        const pdfBase64 = pdfBuffer.toString('base64');
        const stampedBase64 = await imprimirTokenEmPdf(pdfBase64, tokenDoc, { y: tokenYFromBottom });
        const finalBuffer = Buffer.from(stampedBase64, 'base64');

        const dir = path.join(process.cwd(), 'public', 'documentos');
        fs.mkdirSync(dir, { recursive: true });
        const filename = `comprovante_dar_${darId}_${Date.now()}.pdf`;
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, finalBuffer);
        await dbRunAsync(`UPDATE documentos SET caminho = ? WHERE token = ?`, [filePath, tokenDoc]);
        await dbRunAsync(`UPDATE dars SET comprovante_token = ? WHERE id = ?`, [tokenDoc, darId]);

        resolve({ buffer: finalBuffer, token: tokenDoc, filePath });
      } catch (e) {
        reject(e);
      }
    });
    doc.on('error', reject);
  });

  // ==== Conteúdo do PDF ====
  const formatDate = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '');
  const formatCurrency = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

  doc.fontSize(16).fillColor('#333').text('COMPROVANTE DE PAGAMENTO DE DAR', { align: 'center' });

  doc.save();
  doc.fontSize(80).fillColor('#2E7D32').opacity(0.15);
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.text('PAGO', doc.page.width / 2 - 120, doc.page.height / 2 - 40);
  doc.restore();

  const resumoTop = 120;
  doc.rect(50, resumoTop, 495, 70).stroke();
  doc.fontSize(12).fillColor('#000');
  doc.text(`Permissionário: ${dar.nome_empresa || ''}`, 60, resumoTop + 10, { width: 225 });
  doc.text(`CNPJ: ${dar.cnpj || ''}`, 60, resumoTop + 43, { width: 225 });
  doc.text(`Número da Guia: ${numeroGuia}`, 310, resumoTop + 10);
  doc.text(`Data do Pagamento: ${formatDate(pagamento.dataPagamento)}`, 310, resumoTop + 30);
  doc.text(`Valor Pago: ${formatCurrency(pagamento.valorPago)}`, 310, resumoTop + 50);

  const boxTop = resumoTop + 90;
  doc.rect(50, boxTop, 245, 80).stroke();
  doc.rect(300, boxTop, 245, 80).stroke();
  doc.fontSize(11);
  doc.text(`Linha Digitável: ${ld}`, 60, boxTop + 10, { width: 225 });
  doc.text(`Código de Barras: ${ld}`, 310, boxTop + 10, { width: 225 });

  const qrBuffer = await QRCode.toBuffer(ld || numeroGuia || '', { width: 100, margin: 1 });
  doc.image(qrBuffer, 50, boxTop + 100, { width: 100, height: 100 });

  const barcodeBuffer = await bwipjs.toBuffer({
    bcid: 'code128',
    text: ld || numeroGuia || '',
    scale: 3,
    height: 10,
    includetext: false,
  });
  doc.image(barcodeBuffer, 170, boxTop + 130, { width: 350, height: 50 });

  tokenYFromBottom = doc.page.height - ((boxTop + 100) + 100 + cm(2));

  doc.end();

  return endPromise;
}

module.exports = { gerarComprovante };
