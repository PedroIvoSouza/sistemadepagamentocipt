const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');

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
      permissionario_id INTEGER NOT NULL,
      token TEXT NOT NULL,
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

      const permissionario = await dbGet(`SELECT * FROM permissionarios WHERE id = ?`, [permissionarioId]);
      if (!permissionario) {
        return res.status(404).json({ error: 'Permissionário não encontrado.' });
      }

      const pendentes = await dbAll(
        `SELECT mes_referencia, ano_referencia, valor, data_vencimento FROM dars WHERE permissionario_id = ? AND status <> 'Pago'`,
        [permissionarioId]
      );
      if (!pendentes.length) {
        return res.status(400).json({ error: 'Nenhuma DAR pendente para o permissionário.' });
      }

      const total = pendentes.reduce((acc, d) => acc + Number(d.valor || 0), 0);
      const mesesNomes = [
        'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
      ];
      const mesesFormatados = pendentes.map(d => `${mesesNomes[d.mes_referencia - 1]}/${d.ano_referencia}`);
      const mesesStr = mesesFormatados.join(', ');
      const totalStr = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const token = crypto.randomBytes(16).toString('hex');
      const agora = new Date();
      const dataAtual = agora.toLocaleDateString('pt-BR');

      const oficiosDir = path.join(__dirname, '..', '..', 'public', 'oficios');
      fs.mkdirSync(oficiosDir, { recursive: true });
      const fileName = `oficio-${permissionarioId}-${Date.now()}.pdf`;
      const filePath = path.join(oficiosDir, fileName);
      const pdfUrl = `/oficios/${fileName}`;

      const doc = new PDFDocument();
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

      doc.text(
        `Constam pendências de pagamento referentes às competências ${mesesStr}, totalizando ${totalStr}.`,
        { width: 500 }
      );
      doc.moveDown();
      doc.text('Detalhamento das DARs pendentes:');
      pendentes.forEach(d => {
        const mes = String(d.mes_referencia).padStart(2, '0');
        const venc = new Date(d.data_vencimento).toLocaleDateString('pt-BR');
        doc.text(`- ${mes}/${d.ano_referencia} - venc. ${venc} - R$ ${Number(d.valor).toFixed(2)}`);
      });
      doc.moveDown();
      doc.text(`Total devido: ${totalStr}`);
      doc.moveDown(2);
      doc.fontSize(10).text(`Token de autenticação: ${token}`);

      doc.end();
      await new Promise(resolve => stream.on('finish', resolve));

      await dbRun(
        `INSERT INTO oficios_audit (permissionario_id, token, pdf_path, created_at) VALUES (?, ?, ?, ?)`,
        [permissionarioId, token, pdfUrl, agora.toISOString()]
      );

      return res.status(201).json({ token, pdfUrl });
    } catch (err) {
      console.error('[adminOficios] erro:', err);
      return res.status(500).json({ error: 'Erro ao gerar ofício.' });
    }
  }
);

module.exports = router;
