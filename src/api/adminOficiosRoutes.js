// src/api/adminOficiosRoutes.js
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyLetterhead, abntMargins, cm } = require('../utils/pdfLetterhead');
const { gerarTokenDocumento } = require('../utils/token');
const generateTokenQr = require('../utils/qrcodeToken');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const db = require('../database/db');
const router = express.Router();

/* ========= SQLite helpers ========= */
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));

/* ========= Util: imprime token sem mexer no cursor do conteúdo ========= */
function printToken(doc, token, qrBuffer, tokenYOverride) {
  if (!token) return;
  const prevX = doc.x, prevY = doc.y; // preserva cursor do conteúdo

  // desativa temporariamente listeners de pageAdded para evitar recursão
  const pageAddedListeners = doc.listeners('pageAdded');
  doc.removeAllListeners('pageAdded');

  doc.save();
  const x = doc.page.margins.left;
  const qrSize = 40;
  const qrX = doc.page.width - doc.page.margins.right - qrSize;
  const baseY = doc.page.height - doc.page.margins.bottom; // dentro da área útil
  const aviso =
    'Para checar a autenticidade do documento insira o token abaixo no Portal do Permissionário que pode ser acessado através do qr code ao lado.';
  const avisoWidth = qrX - x - 10;
  doc.fontSize(7).fillColor('#222');
  const avisoHeight = doc.heightOfString(aviso, { width: avisoWidth });

  // posiciona elementos acima de baseY para garantir que não ultrapassem a página
  let tokenY = baseY - qrSize + 8;
  if (typeof tokenYOverride === 'number') tokenY = tokenYOverride;
  const avisoY = tokenY - avisoHeight - 2;

  doc.text(aviso, x, avisoY, { width: avisoWidth });

  const text = `Token: ${token}`;
  doc.fontSize(8).text(text, x, tokenY, { lineBreak: false });
  doc.image(qrBuffer, qrX, tokenY - (qrSize - 8), {
    fit: [qrSize, qrSize],
  });
  doc.restore();
  doc.x = prevX;
  doc.y = prevY; // restaura cursor do conteúdo

  // reativa listeners de pageAdded
  for (const l of pageAddedListeners) doc.on('pageAdded', l);
}

/* ===========================================================
   GET /api/admin/oficios/:permissionarioId
   Gera o ofício para um permissionário com timbrado PNG + ABNT
   =========================================================== */
router.get(
  '/oficios/:permissionarioId',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { permissionarioId } = req.params;

      // 1) Dados do permissionário
      const perm = await dbGet(`SELECT id, nome_empresa, cnpj, email, tipo FROM permissionarios WHERE id = ?`, [permissionarioId]);
      if (!perm) {
        return res.status(404).json({ error: 'Permissionário não encontrado.' });
      }

      // 2) Débitos em aberto (exemplo: tudo não pago e vencido)
      const debitos = await dbAll(
        `SELECT id, ano_referencia, mes_referencia, data_vencimento, valor
           FROM dars
          WHERE permissionario_id = ?
            AND status <> 'Pago'
            AND DATE(data_vencimento) < DATE('now')
          ORDER BY data_vencimento ASC`,
        [permissionarioId]
      );

      const totalDevido = debitos.reduce((acc, d) => acc + Number(d.valor || 0), 0);
      const totalStr = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalDevido);

      const tokenDoc = await gerarTokenDocumento('OFICIO', permissionarioId, db);
      const qrBuffer = await generateTokenQr(tokenDoc);

      // 3) Cria PDF com margens ABNT (+0,5cm topo/rodapé)
      const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5, 2) });
      doc.on('error', err => {
        console.error('[adminOficios] pdf error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      // 4) Aplica papel timbrado (todas as páginas)
      const renderLetterhead = applyLetterhead(doc, { imagePath: path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png') });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="oficio_${permissionarioId}.pdf"`);
      res.setHeader('X-Document-Token', tokenDoc);
      doc.pipe(res);

      // 5) Cursor inicial na área útil
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;

      // 6) Conteúdo do ofício
      const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      const hoje = new Date();
      const dataBR = hoje.toLocaleDateString('pt-BR');
      const titulo = 'OFÍCIO SECTI SUPTI - PENDÊNCIAS DE PAGAMENTOS';
      doc.fillColor('#333').fontSize(14).text(titulo, { align: 'center', width: larguraUtil });
      doc.moveDown(1);

      doc.fontSize(11).text(`Maceió, ${dataBR}`, { align: 'right', width: larguraUtil });
      doc.moveDown(2);

      // Destinatário
      doc.font('Helvetica-Bold').text(perm.nome_empresa, { width: larguraUtil });
      doc.font('Helvetica').text(`CNPJ: ${perm.cnpj}`, { width: larguraUtil });
      if (perm.email) doc.text(`E-mail: ${perm.email}`, { width: larguraUtil });
      if (perm.tipo) doc.text(`Tipo: ${perm.tipo}`, { width: larguraUtil });
      doc.moveDown(2);

      // Corpo (exemplo; ajuste ao seu texto oficial)
      const corpo = [
        `Prezados,`,
        `Identificamos pendências financeiras em aberto referentes aos contratos de uso do espaço no Centro de Inovação do Polo Tecnológico (CIPT).`,
        `Solicitamos a regularização no prazo de 5 (cinco) dias úteis a contar do recebimento deste ofício.`,
        `O valor total devido até a presente data é de ${totalStr}.`,
      ].join('\n\n');

      doc.text(corpo, {
        width: larguraUtil,
        align: 'justify',
        lineGap: 2,
      });
      doc.moveDown(1.5);

      // Tabela simples com os títulos vencidos (se houver)
      if (debitos.length) {
        doc.font('Helvetica-Bold').text('Títulos em aberto:', { width: larguraUtil });
        doc.moveDown(0.5);
        doc.font('Helvetica');

        const rowHeight = 18;
        let y = doc.y;

        // Cabeçalho
        const cols = [
          { w: larguraUtil * 0.25, label: 'Vencimento' },
          { w: larguraUtil * 0.25, label: 'Referência (mês/ano)' },
          { w: larguraUtil * 0.25, label: 'DAR' },
          { w: larguraUtil * 0.25, label: 'Valor (R$)' },
        ];

        const drawRow = (cells, yy, bold = false) => {
          let x = doc.page.margins.left;
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
          cells.forEach((cell, i) => {
            doc.text(String(cell), x + 2, yy + 4, {
              width: cols[i].w - 4,
              lineBreak: false,
            });
            doc.rect(x, yy, cols[i].w, rowHeight).stroke('#ccc');
            x += cols[i].w;
          });
        };

        drawRow(cols.map(c => c.label), y, true);
        y += rowHeight;

        for (const d of debitos) {
          // quebra de página segura (não escrever nada em pageAdded além do token)
          if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 10) {
            doc.addPage();
            y = doc.page.margins.top;
            drawRow(cols.map(c => c.label), y, true);
            y += rowHeight;
          }
          const mesAno = String(d.mes_referencia).padStart(2, '0') + '/' + d.ano_referencia;
          drawRow(
            [
              new Date(d.data_vencimento).toLocaleDateString('pt-BR'),
              mesAno,
              d.id,
              Number(d.valor || 0).toFixed(2),
            ],
            y
          );
          y += rowHeight;
        }

        // resetar âncora horizontal antes de qualquer texto corrido
        doc.x = doc.page.margins.left;
        doc.y = y + 10;
        doc.moveDown(1);
        
        doc.font('Helvetica-Bold').text(
          `Total devido: ${totalStr}`,
          doc.page.margins.left,
          doc.y,
          { width: larguraUtil, align: 'left' }
        );
        doc.font('Helvetica');
        doc.moveDown(1.5);
      }

      // Fecho (justificado + centralizado, ancorado no left)
      {
        const left = doc.page.margins.left;
        const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      
        // Garantir âncora correta
        doc.x = left;
      
        // 1) Parágrafo justificado
        doc.font('Helvetica').fontSize(11).text(
          'Para quaisquer esclarecimentos, permanecemos à disposição.',
          left,
          doc.y,
          { width: larguraUtil, align: 'justify', lineGap: 2 }
        );
        doc.moveDown(1);
      
        // 2) "Atenciosamente," à esquerda
        doc.text('Atenciosamente,', left, doc.y, { width: larguraUtil, align: 'left' });
        doc.moveDown(2);
      
        // 3) Bloco centralizado (sem cortar à direita)
        const blocoAltura = 40;
        if (doc.y + blocoAltura > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          doc.x = left; // reancora em nova página
        }
      
        doc.font('Helvetica-Bold').fontSize(10).text(
          'DOCUMENTO ASSINADO DIGITALMENTE',
          left,
          doc.y,
          { width: larguraUtil, align: 'center' }
        );
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(10).text(
          'Secretaria de Estado da Ciência, da Tecnologia e da Inovação',
          left,
          doc.y,
          { width: larguraUtil, align: 'center' }
        );
      }

      // 7) Token ~2cm abaixo da assinatura
      {
        const twoCm = cm(2);
        const qrSize = 40;
        let tokenY = doc.y + twoCm;
        if (tokenY + qrSize > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          tokenY = doc.page.margins.top + twoCm;
        }
        printToken(doc, tokenDoc, qrBuffer, tokenY);
      }

      // 8) Finaliza
      renderLetterhead();
      doc.end();

      // (opcional) gravar referência no banco
      await dbRun(
        `INSERT INTO documentos (tipo, caminho, token) VALUES (?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET caminho = excluded.caminho`,
        // caminho vazio pois foi stream direto; se quiser salvar arquivo, mude o pipe para fs
        ['OFICIO', '', tokenDoc]
      );
    } catch (err) {
      console.error('[adminOficios] erro:', err.stack || err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Erro ao gerar ofício.' });
      }
    }
  }
);

module.exports = router;
