// src/api/permissionariosRoutes.js
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const authMiddleware = require('../middleware/authMiddleware');
const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');
const { gerarTokenDocumento } = require('../utils/token');

const db = require('../database/db');
const router = express.Router();

/* =========================
   Helpers SQLite (promises)
   ========================= */
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

/* =========================
   Helpers PDF
   ========================= */
function printToken(doc, token) {
  if (!token) return;
  const prevX = doc.x, prevY = doc.y;
  doc.save();
  const x = doc.page.margins.left;
  const y = doc.page.height - doc.page.margins.bottom - 10; // dentro da área útil
  doc.fontSize(8).fillColor('#222').text(`Token: ${token}`, x, y, { lineBreak: false });
  doc.restore();
  doc.x = prevX; doc.y = prevY;
}

function fmtId(docStr) {
  const s = String(docStr || '').replace(/\D/g, '');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'); // CNPJ
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');           // CPF (não usado aqui)
  return docStr || '';
}

/* ===========================================================
   GET /api/permissionarios/:id/certidao
   - Emite Certidão de Quitação padronizada
   - Bloqueia se houver DARs vencidos e não pagos
   =========================================================== */
router.get('/:id/certidao', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = req.user || {};
  const isAdmin = !!user.role;

  // Somente o próprio permissionário ou um admin pode emitir
  if (!isAdmin && Number(user.id) !== id) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    // ✅ TIRA o cpf do SELECT (sua tabela não tem essa coluna)
    const perm = await getAsync(
      `SELECT id, nome_empresa, cnpj, email, tipo FROM permissionarios WHERE id = ?`,
      [id]
    );
    if (!perm) {
      return res.status(404).json({ error: 'Permissionário não encontrado.' });
    }

    // Verifica pendências (DARs vencidos e não pagos)
    const pend = await getAsync(
      `SELECT COUNT(*) AS count
         FROM dars
        WHERE permissionario_id = ?
          AND status <> 'Pago'
          AND DATE(data_vencimento) < DATE('now')`,
      [id]
    );
    if ((pend?.count || 0) > 0) {
      return res
        .status(422)
        .json({ error: 'Existem pendências financeiras; não é possível processar a certidão de quitação.' });
    }

    // Garante tabela de certidões (persistir histórico)
    await runAsync(`CREATE TABLE IF NOT EXISTS certidoes_quitacao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permissionario_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      file_path TEXT NOT NULL,
      data_emissao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(permissionario_id) REFERENCES permissionarios(id)
    )`);

    // Token padronizado do sistema (também usado em /api/documentos/validar)
    const tokenDoc = await gerarTokenDocumento('CERTIDAO_QUITACAO', id, db);

    // Caminho público onde o PDF ficará disponível
    const dir = path.join(__dirname, '..', '..', 'public', 'permissionarios', 'certidoes');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `certidao_${id}_${Date.now()}.pdf`;
    const filePath = path.join(dir, filename);
    const publicRelativePath = path.join('permissionarios', 'certidoes', filename); // para servir via /public

    // Documento PDF: padrão timbrado + ABNT + 0,5cm
    const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5) });

    // Coleta em buffer para salvar em disco e enviar ao cliente
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', async () => {
      try {
        const pdfData = Buffer.concat(chunks);
        fs.writeFileSync(filePath, pdfData);

        // Registra na tabela específica
        await runAsync(
          `INSERT INTO certidoes_quitacao (permissionario_id, token, file_path)
           VALUES (?, ?, ?)`,
          [id, tokenDoc, publicRelativePath]
        );

        // Também registra em "documentos" para validação pública
        await runAsync(
          `INSERT INTO documentos (tipo, caminho, token)
             VALUES (?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET caminho = excluded.caminho`,
          ['CERTIDAO_QUITACAO', filePath, tokenDoc]
        );

        // Envia o PDF ao cliente
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="certidao_quitacao_${id}.pdf"`);
        res.setHeader('X-Document-Token', tokenDoc);
        res.send(pdfData);
      } catch (e) {
        console.error('[certidao] falha ao finalizar stream:', e);
        if (!res.headersSent) res.status(500).json({ error: 'Erro ao finalizar a certidão.' });
      }
    });

    // === Renderização ===
    // Papel timbrado em todas as páginas
    applyLetterhead(doc, { imagePath: path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png') });

    // Cursor inicial na área útil + token por página
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
    printToken(doc, tokenDoc);
    doc.on('pageAdded', () => {
      // Só anota o token e reposiciona o cursor (sem escrever blocos longos aqui!)
      printToken(doc, tokenDoc);
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
    });

    const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const hoje = new Date();
    const dataBR = hoje.toLocaleDateString('pt-BR');

    // Documento fiscal (usa só CNPJ aqui)
    const idFiscal = fmtId(perm.cnpj);

    // Título
    doc.fillColor('#333').fontSize(16).text(
      'CERTIDÃO DE QUITAÇÃO',
      doc.page.margins.left,
      doc.y,
      { width: larguraUtil, align: 'center' }
    );
    doc.moveDown(2);

    // Identificação
    doc.font('Helvetica-Bold').fontSize(11).text('Identificação do Permissionário', doc.page.margins.left, doc.y, {
      width: larguraUtil
    });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11);
    doc.text(`Razão/Nome: ${perm.nome_empresa || '-'}`, doc.page.margins.left, doc.y, { width: larguraUtil });
    if (idFiscal) doc.text(`Documento: ${idFiscal}`, doc.page.margins.left, doc.y, { width: larguraUtil });
    if (perm.email) doc.text(`E-mail: ${perm.email}`, doc.page.margins.left, doc.y, { width: larguraUtil });
    if (perm.tipo) doc.text(`Tipo: ${perm.tipo}`, doc.page.margins.left, doc.y, { width: larguraUtil });
    doc.moveDown(1.5);

    // Corpo (justificado)
    const corpo = [
      `Certificamos, para os devidos fins, que a pessoa jurídica acima identificada encontra-se QUITE com suas obrigações financeiras junto ao Centro de Inovação do Polo Tecnológico (CIPT) até a data de emissão desta certidão.`,
      `Esta certidão é válida exclusivamente na presente data e não constitui quitação futura de débitos que venham a ser constituídos após sua emissão.`
    ].join('\n\n');

    doc.text(corpo, doc.page.margins.left, doc.y, {
      width: larguraUtil,
      align: 'justify',
      lineGap: 2
    });
    doc.moveDown(2);

    // Local e data (direita)
    doc.text(`Maceió, ${dataBR}`, doc.page.margins.left, doc.y, {
      width: larguraUtil,
      align: 'right'
    });
    doc.moveDown(2);

    // Fecho
    {
      const left = doc.page.margins.left;

      doc.text(
        'Para quaisquer esclarecimentos, permanecemos à disposição.',
        left,
        doc.y,
        { width: larguraUtil, align: 'justify', lineGap: 2 }
      );
      doc.moveDown(1);

      doc.text('Atenciosamente,', left, doc.y, { width: larguraUtil, align: 'left' });
      doc.moveDown(2);

      // Bloco centralizado de assinatura digital
      const blocoAltura = 40;
      if (doc.y + blocoAltura > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        doc.x = left;
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

  // Finaliza
  doc.end();
} catch (err) {
    console.error('[permissionarios/certidao] erro:', err.stack || err);
    res.status(500).json({ error: err.message || 'Erro ao gerar certidão.' });
}
});

module.exports = router;
