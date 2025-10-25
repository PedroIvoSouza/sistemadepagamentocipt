import express from 'express';
import PDFDocument from 'pdfkit';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');

// Placeholder implementations to keep the flow intact
function applyLetterhead(doc) {
  // In the real server this would draw the official letterhead
}

function imprimirTokenEmPdf(token, buffer) {
  // Persist the PDF using the provided token in the real application
}

const router = express.Router();

router.get('/:id/comprovante', async (req, res, next) => {
  try {
    const { id } = req.params;

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    applyLetterhead(doc);

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      imprimirTokenEmPdf(id, pdf);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(pdf);
    });

    // --- PDF content -----------------------------------------------------
    doc.fontSize(20).text('Comprovante de DAR', { align: 'center' });
    doc.fontSize(32).fillColor('green').text('PAGO', { align: 'right' }).fillColor('black');

    doc.moveDown().fontSize(14).text('Pagamento confirmado');

    doc.moveDown().fontSize(12).text('Dados do Pagador', { underline: true });
    doc.fontSize(10).text('Nome: _________________________');
    doc.text('CPF/CNPJ: _____________________');

    doc.moveDown().fontSize(12).text('Detalhes da DAR', { underline: true });
    doc.fontSize(10).text(`Número: ${id}`);
    doc.text('Valor: _________________________');

    const verifyUrl = `${process.env.VERIFY_BASE || ''}/dar/${id}`;
    const qrCodeData = await QRCode.toDataURL(verifyUrl);
    const qrImage = qrCodeData.replace(/^data:image\/png;base64,/, '');
    doc.image(Buffer.from(qrImage, 'base64'), { width: 100, height: 100 });

    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: `DAR${id}`,
      scale: 3,
      height: 10,
      includetext: false
    });
    doc.image(barcodeBuffer, { width: 300, height: 50 });
    doc.font('Courier').fontSize(10).text('Linha digitável: 0000.00000 0000.000000 0000.000000 0 00000000000000');

    doc.moveDown().font('Helvetica').fontSize(8).text(`Documento emitido em ${new Date().toLocaleString()} - Token: ${id}`, {
      align: 'center'
    });
    // ---------------------------------------------------------------------

    doc.end();
  } catch (err) {
    next(err);
  }
});

export default router;
