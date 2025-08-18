const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

router.get('/:id/certidao', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = req.user || {};
  const isAdmin = !!user.role;

  if (!isAdmin && user.id !== id) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const perm = await getAsync(
      `SELECT id, nome_empresa, cnpj FROM permissionarios WHERE id = ?`,
      [id]
    );
    if (!perm) {
      return res.status(404).json({ error: 'Permissionário não encontrado.' });
    }

    const pend = await getAsync(
      `SELECT COUNT(*) as count FROM dars WHERE permissionario_id = ? AND status = 'Pendente' AND DATE(data_vencimento) < DATE('now')`,
      [id]
    );
    if ((pend?.count || 0) > 0) {
      return res
        .status(400)
        .json({ error: 'Existem DARs pendentes para este permissionário.' });
    }

    await runAsync(`CREATE TABLE IF NOT EXISTS certidoes_quitacao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permissionario_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      file_path TEXT NOT NULL,
      data_emissao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(permissionario_id) REFERENCES permissionarios(id)
    )`);

    const token = randomBytes(16).toString('hex');

    const dir = path.join(
      __dirname,
      '..',
      '..',
      'public',
      'permissionarios',
      'certidoes'
    );
    fs.mkdirSync(dir, { recursive: true });
    const filename = `certidao_${id}_${Date.now()}.pdf`;
    const filePath = path.join(dir, filename);

    const doc = new PDFDocument();
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdfData = Buffer.concat(buffers);
      fs.writeFileSync(filePath, pdfData);
      await runAsync(
        `INSERT INTO certidoes_quitacao (permissionario_id, token, file_path) VALUES (?, ?, ?)`,
        [id, token, path.join('permissionarios', 'certidoes', filename)]
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.send(pdfData);
    });

    doc.fontSize(14).text(
      'Secretaria de Estado de Ciência, Tecnologia e Inovação - SECTI',
      { align: 'center' }
    );
    doc.moveDown(2);
    doc.fontSize(12).text('Certidão de Quitação', { align: 'center' });
    doc.moveDown();
    doc
      .fontSize(12)
      .text(
        `Certificamos que ${perm.nome_empresa} (CNPJ: ${perm.cnpj}) não possui débitos pendentes junto ao Centro de Inovação do Porto Digital, na data desta emissão.`,
        { align: 'justify' }
      );
    doc.moveDown();
    doc.fontSize(10).text(`Token de verificação: ${token}`);
    doc
      .fontSize(10)
      .text(`Emitido em ${new Date().toLocaleDateString('pt-BR')}`, {
        align: 'right'
      });
    doc.end();
  } catch (err) {
    console.error('Erro ao gerar certidão:', err);
    res.status(500).json({ error: 'Erro ao gerar certidão.' });
  }
});

module.exports = router;
