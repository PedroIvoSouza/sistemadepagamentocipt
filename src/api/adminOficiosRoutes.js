const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const router = express.Router();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));

// Tabela de auditoria para oficios
(async () => {
  try {
    await dbRun(`CREATE TABLE IF NOT EXISTS oficios_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER NOT NULL,
      pdf_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
  } catch (e) {
    console.error('[adminOficios] erro ao criar tabela oficios_audit:', e.message);
  }
})();

router.post(
  '/:permissionarioId',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { permissionarioId } = req.params;
      const { numeroProcesso = '___/____/____', dataLimite = '__/__/____' } = req.body || {};

      const permissionario = await dbGet(`SELECT * FROM permissionarios WHERE id = ?`, [permissionarioId]);
      if (!permissionario) {
        return res.status(404).json({ error: 'Permissionário não encontrado.' });
      }

      const pendentes = await dbAll(
        `SELECT mes_referencia, ano_referencia, valor, data_vencimento FROM dars WHERE permissionario_id = ? AND status <> 'Pago' AND DATE(data_vencimento) < DATE('now')`,
        [permissionarioId]
      );
      if (!pendentes.length) {
        return res.status(400).json({ error: 'Nenhuma DAR pendente para o permissionário.' });
      }

      const total = pendentes.reduce((acc, d) => acc + Number(d.valor || 0), 0);
      const tokenDoc = await gerarTokenDocumento('oficio', permissionarioId);
      const docRow = await dbGet(`SELECT id FROM documentos WHERE token = ?`, [tokenDoc]);
      const documentoId = docRow ? docRow.id : null;

      const mesesNomes = [
        'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
      ];
      const mesesFormatados = pendentes.map(d => `${mesesNomes[d.mes_referencia - 1]}/${d.ano_referencia}`);
      const mesesStr = mesesFormatados.join(', ');
      const totalStr = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const agora = new Date();
      const dataAtual = agora.toLocaleDateString('pt-BR');

      const oficiosDir = path.join(__dirname, '..', '..', 'public', 'oficios');
      fs.mkdirSync(oficiosDir, { recursive: true });
      const fileName = `oficio-${permissionarioId}-${Date.now()}.pdf`;
      const filePath = path.join(oficiosDir, fileName);
      const pdfUrl = `/oficios/${fileName}`;

      const doc = new PDFDocument({ size: 'A4', margins: { top: 85, left: 85, right: 56, bottom: 56 } });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const logoPath = path.join(__dirname, '..', '..', 'public', 'images', 'logo-secti-vertical.png');
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 40, { width: 80 });
      }
      doc.fontSize(18).text('Ofício', { align: 'center' });
      doc.moveDown();

      doc.fontSize(12).text(`Empresa: ${permissionario.nome_empresa}`);
      doc.text(`CNPJ: ${permissionario.cnpj}`);
      doc.text(`Data: ${dataAtual}`);
      doc.moveDown();

      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.text(
        `Constam pendências de pagamento referentes às competências ${mesesStr}, totalizando ${totalStr}.`,
        { width: contentWidth }
      );
      doc.moveDown();
      doc.text('Detalhamento das DARs pendentes:');
      pendentes.forEach(d => {
        const mes = String(d.mes_referencia).padStart(2, '0');
        const venc = new Date(d.data_vencimento).toLocaleDateString('pt-BR');
        doc.text(`- ${mes}/${d.ano_referencia} - venc. ${venc} - R$ ${Number(d.valor).toFixed(2)}`);
      });
      doc.moveDown();
      doc.text(`Total devido: R$ ${total.toFixed(2)}`);
      doc.text(`Total devido: ${totalStr}`);
      doc.moveDown(2);
      doc.fontSize(10).text(`Token de autenticação: ${tokenDoc}`);
      const headerPath = path.join(__dirname, '..', '..', 'public', 'images', 'papel-timbrado-secti.png');

      const addHeader = () => {
        if (fs.existsSync(headerPath)) {
          doc.image(headerPath, 0, 0, { width: doc.page.width });
        }
        doc.y = doc.page.margins.top;
      };

      const addFooter = () => {
        doc
          .font('Times-Roman')
          .fontSize(10)
          .text(
            `Token de autenticidade: ${tokenDoc}`,
            doc.page.margins.left,
            doc.page.height - doc.page.margins.bottom + 20
          );
      };

      doc.on('pageAdded', () => {
        addHeader();
        addFooter();
      });

      addHeader();

      const listaPendencias = pendentes
        .map(d => {
          const mes = String(d.mes_referencia).padStart(2, '0');
          const venc = new Date(d.data_vencimento).toLocaleDateString('pt-BR');
          return `- ${mes}/${d.ano_referencia} - venc. ${venc} - R$ ${Number(d.valor).toFixed(2)}`;
        })
        .join('\n');

      const paragrafos = [
        `À empresa ${permissionario.nome_empresa}, inscrita no CNPJ ${permissionario.cnpj},`,
        `Conforme Processo Administrativo nº ${numeroProcesso}, notificamos que constam em aberto os débitos abaixo relacionados:`,
        listaPendencias,
        `Total devido: R$ ${total.toFixed(2)}.`,
        `Solicitamos a quitação até ${dataLimite}.`,
        `Goiânia, ${dataAtual}.`,
        `Atenciosamente,`,
        `Secretaria de Ciência, Tecnologia e Inovação`,
      ];

      paragrafos.forEach(p => {
        doc.font('Times-Roman').fontSize(12).text(p, {
          align: 'justify',
          lineGap: 4,
          paragraphGap: 12,
        });
      });

      addFooter();
      doc.end();
      await new Promise(resolve => stream.on('finish', resolve));

      let pdfBase64 = fs.readFileSync(filePath).toString('base64');
      pdfBase64 = await imprimirTokenEmPdf(pdfBase64, tokenDoc);
      fs.writeFileSync(filePath, Buffer.from(pdfBase64, 'base64'));

      await dbRun(`UPDATE documentos SET caminho = ? WHERE token = ?`, [filePath, tokenDoc]);

      if (documentoId) {
        await dbRun(
          `INSERT INTO oficios_audit (documento_id, pdf_path, created_at) VALUES (?, ?, ?)`,
          [documentoId, pdfUrl, agora.toISOString()]
        );
      }

      return res.status(201).json({ token: tokenDoc, pdfUrl });
    } catch (err) {
      console.error('[adminOficios] erro:', err);
      return res.status(500).json({ error: 'Erro ao gerar ofício.' });
    }
  }
);

module.exports = router;
