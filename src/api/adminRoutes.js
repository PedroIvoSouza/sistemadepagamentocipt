// src/api/adminRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { Parser } = require('json2csv');
const xlsx = require('xlsx');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { gerarTokenDocumento } = require('../utils/token');
const os = require('os');
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');

// Middlewares
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const router = express.Router();
const db = new sqlite3.Database(DB_PATH);

/* =========================
   Helpers SQLite (promises)
   ========================= */
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

/* =========================
   Índices para performance
   - idempotentes (IF NOT EXISTS)
   - importantes para as queries do dashboard
   ========================= */
async function ensureIndexes() {
  try {
    await dbRun(`PRAGMA journal_mode = WAL;`);
  } catch {}
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_status             ON dars(status);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_data_vencimento    ON dars(data_vencimento);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_status_venc        ON dars(status, data_vencimento);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_permissionario     ON dars(permissionario_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_perm_nome               ON permissionarios(nome_empresa);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_perm_cnpj               ON permissionarios(cnpj);`);
}
ensureIndexes().catch(e => console.error('[adminRoutes] ensureIndexes error:', e.message));

/* ===========================================================
   GET /api/admin/dashboard-stats
   - Usa ISO yyyy-mm-dd como parâmetro => ativa índice por comparação
   - "vencidas" = não pagas com data_vencimento < hoje
   =========================================================== */
router.get(
  '/dashboard-stats',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const isoToday = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      const totalPermissionarios = (await dbGet(
        `SELECT COUNT(*) AS count FROM permissionarios`
      )).count;

      // Em aberto (não pagos)
      const pendRow = await dbGet(
        `SELECT COUNT(*) AS qnt, COALESCE(SUM(valor),0) AS valor
         FROM dars
         WHERE status <> 'Pago'`
      );
      const darsPendentes   = pendRow?.qnt ?? 0;
      const receitaPendente = Number(pendRow?.valor ?? 0);

      // Vencidos: não pagos com vencimento anterior a hoje (comparação textual ativa índice)
      const vencRow = await dbGet(
        `SELECT COUNT(*) AS qnt
         FROM dars
         WHERE status <> 'Pago'
           AND data_vencimento < ?`,
        [isoToday]
      );
      const darsVencidos = vencRow?.qnt ?? 0;

      // Resumo mensal (últimos 6 grupos)
      const resumoMensal = await dbAll(
        `SELECT
            CAST(strftime('%Y', data_vencimento) AS INTEGER) AS ano_referencia,
            CAST(strftime('%m', data_vencimento) AS INTEGER) AS mes_referencia,
            COUNT(*)                                                  AS emitidas,
            SUM(CASE WHEN status = 'Pago' THEN 1 ELSE 0 END)          AS pagas,
            SUM(CASE WHEN status <> 'Pago' AND data_vencimento < ? THEN 1 ELSE 0 END) AS vencidas
         FROM dars
         GROUP BY ano_referencia, mes_referencia
         ORDER BY ano_referencia DESC, mes_referencia DESC
         LIMIT 6`,
        [isoToday]
      );

      // Maiores devedores: não pagos
      const maioresDevedores = await dbAll(
        `SELECT
            p.nome_empresa,
            SUM(d.valor) AS total_devido
         FROM dars d
         JOIN permissionarios p ON p.id = d.permissionario_id
         WHERE d.status <> 'Pago'
           AND DATE(d.data_vencimento) < DATE('now')
         GROUP BY p.id, p.nome_empresa
         HAVING total_devido > 0
         ORDER BY total_devido DESC
         LIMIT 5`
      );

      res.status(200).json({
        totalPermissionarios,
        darsPendentes,
        darsVencidos,
        receitaPendente: receitaPendente.toFixed(2),
        resumoMensal,
        maioresDevedores,
      });
    } catch (error) {
      console.error('Erro ao buscar estatísticas:', error);
      res.status(500).json({ error: 'Erro ao buscar as estatísticas do dashboard.' });
    }
  }
);

/* ===========================================================
   Rotas de Permissionários (mantidas como você tinha)
   =========================================================== */

// GET /api/admin/permissionarios
router.get(
  '/permissionarios',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { search = '', page = 1, limit = 10 } = req.query;
      const offset = (page - 1) * limit;

      let whereClause = '';
      const params = [];
      if (search) {
        whereClause = `
          WHERE nome_empresa LIKE ?
             OR cnpj         LIKE ?
        `.trim();
        params.push(`%${search}%`, `%${search}%`);
      }

      const countSql = `SELECT COUNT(*) as count FROM permissionarios ${whereClause}`;
      const totalResult = await dbGet(countSql, params);
      const totalPermissionarios = totalResult.count;

      const dataSql = `
        SELECT id, nome_empresa, cnpj, email, telefone, numero_sala
        FROM permissionarios
        ${whereClause}
        ORDER BY nome_empresa ASC
        LIMIT ? OFFSET ?
      `;
      const permissionarios = await dbAll(dataSql, [...params, limit, offset]);

      res.status(200).json({
        permissionarios,
        totalPages: Math.ceil(totalPermissionarios / limit),
        currentPage: Number(page),
      });
    } catch (error) {
      console.error('Erro ao buscar permissionários:', error);
      res.status(500).json({ error: 'Erro ao buscar a lista de permissionários.' });
    }
  }
);

// GET /api/admin/permissionarios/:id
router.get(
  '/permissionarios/:id',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const user = await dbGet(
        `SELECT * FROM permissionarios WHERE id = ?`,
        [id]
      );
      if (user) {
        res.json(user);
      } else {
        res.status(404).json({ error: 'Permissionário não encontrado.' });
      }
    } catch (error) {
      console.error('Erro na rota GET /permissionarios/:id:', error);
      res.status(500).json({ error: 'Erro ao buscar dados do permissionário.' });
    }
  }
);

// PUT /api/admin/permissionarios/:id
router.put(
  '/permissionarios/:id',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    const { id } = req.params;
    const {
      nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel,
    } = req.body;

    try {
      const sql = `
        UPDATE permissionarios SET
          nome_empresa = ?, cnpj = ?, email = ?, telefone = ?, numero_sala = ?, valor_aluguel = ?
        WHERE id = ?
      `;
      const params = [
        nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel, id,
      ];

      await new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
          if (err) return reject(err);
          if (this.changes === 0)
            return reject(new Error('Permissionário não encontrado.'));
          resolve(this);
        });
      });

      res.status(200).json({ message: 'Permissionário atualizado com sucesso!' });
    } catch (error) {
      console.error('Erro ao atualizar permissionário:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /api/admin/permissionarios
router.post(
  '/permissionarios',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    const {
      nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel,
    } = req.body;

    try {
      const sql = `
        INSERT INTO permissionarios
          (nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      const params = [
        nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel,
      ];

      const result = await new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
          if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
              return reject(new Error('CNPJ ou E-mail já cadastrado no sistema.'));
            }
            return reject(err);
          }
          resolve(this);
        });
      });

      res.status(201).json({
        message: 'Permissionário cadastrado com sucesso!',
        id: result.lastID,
      });
    } catch (error) {
      console.error('Erro ao cadastrar permissionário:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/* ===========================================================
   Exportações (CSV, XLSX, PDF) — mantidas como estavam
   =========================================================== */
router.get(
  '/permissionarios/export/:format',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { format } = req.params;
      const { search = '' } = req.query;

      let whereClause = '';
      const params = [];
      if (search) {
        whereClause = `
          WHERE nome_empresa LIKE ?
             OR cnpj         LIKE ?
        `.trim();
        params.push(`%${search}%`, `%${search}%`);
      }

      const permissionarios = await dbAll(
        `
        SELECT nome_empresa, cnpj, email, telefone, numero_sala
        FROM permissionarios
        ${whereClause}
        ORDER BY nome_empresa ASC
      `,
        params
      );

      if (permissionarios.length === 0) {
        return res.status(404).send('Nenhum dado encontrado para exportar.');
      }

      // CSV
      if (format === 'csv') {
        const csv = new Parser().parse(permissionarios);
        res.header('Content-Type', 'text/csv');
        res.attachment('permissionarios.csv');
        return res.send(csv);
      }

      // XLSX
      if (format === 'xlsx') {
        const ws = xlsx.utils.json_to_sheet(permissionarios);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Permissionários');
        const buf = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
        res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.attachment('permissionarios.xlsx');
        return res.send(buf);
      }

      // PDF
      if (format === 'pdf') {
        const tokenDoc = await gerarTokenDocumento('RELATORIO_PERMISSIONARIOS', null);
        const doc = new PDFDocument({
          layout: 'landscape',
          size: 'A4',
          margins: { top: 50, bottom: 50, left: 50, right: 50 },
        });
        res.header('Content-Type', 'application/pdf');
        res.attachment('permissionarios.pdf');
        res.setHeader('X-Document-Token', tokenDoc);
        doc.pipe(res);

        doc.on('pageAdded', () => {
          generateFooter(doc, tokenDoc);
          generateHeader(doc);
        });

        generateHeader(doc);
        generateFooter(doc, tokenDoc);
        doc.fillColor('#333').fontSize(16).text('Relatório de Permissionários', { align: 'center' });
        doc.moveDown(2);
        generateTable(doc, permissionarios);

        doc.end();
        return;
      }

      return res.status(400).json({ error: 'Formato de exportação inválido.' });
    } catch (error) {
      console.error('Erro ao exportar permissionários:', error);
      res.status(500).json({ error: 'Erro ao exportar os dados.' });
    }
  }
);

/* ===========================================================
   GET /api/admin/relatorios/devedores
   =========================================================== */
router.get(
  '/relatorios/devedores',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const devedores = await dbAll(
        `SELECT
            p.nome_empresa,
            p.cnpj,
            COUNT(d.id)  AS quantidade_dars,
            SUM(d.valor) AS total_devido
         FROM dars d
         JOIN permissionarios p ON p.id = d.permissionario_id
         WHERE d.status <> 'Pago'
           AND DATE(d.data_vencimento) < DATE('now')
         GROUP BY p.id, p.nome_empresa, p.cnpj
         HAVING total_devido > 0
         ORDER BY total_devido DESC`
      );

      if (!devedores.length) {
        return res.status(404).json({ error: 'Nenhum devedor encontrado.' });
      }

      const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secti-'));
      const filePath = path.join(tmpDir, `relatorio_devedores_${Date.now()}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const tokenDoc = await gerarTokenDocumento('RELATORIO_DEVEDORES', null);

      doc.on('pageAdded', () => {
        generateFooter(doc, tokenDoc);
        generateHeader(doc);
      });

      generateHeader(doc);
      generateFooter(doc, tokenDoc);
      doc.fillColor('#333').fontSize(16).text('Relatório de Devedores', { align: 'center' });
      doc.moveDown(2);
      generateDebtorsTable(doc, devedores);
      doc.end();

      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      await dbRun(
        `INSERT INTO documentos (tipo, caminho, token) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET caminho = excluded.caminho`,
        ['RELATORIO_DEVEDORES', filePath, tokenDoc]
      );


      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio_devedores.pdf"');
      res.setHeader('X-Document-Token', tokenDoc);
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      fileStream.on('close', () => {
        fs.unlink(filePath, () => {
          fs.rmdir(tmpDir, () => {});
        });
      });
    } catch (error) {
      console.error('Erro ao gerar relatório devedores:', error);
      res.status(500).json({ error: 'Erro ao gerar o relatório de devedores.' });
    }
  }
);

/* ===========================================================
   Helpers para PDF
   =========================================================== */
function generateHeader(doc) {
  const sectiLogoPath = path.join(__dirname, '..', '..', 'public', 'images', 'LOGO SECTI.png');
  doc.rect(0, 0, doc.page.width, 80).fill('#0056a0');
  try {
    if (fs.existsSync(sectiLogoPath)) {
      doc.image(sectiLogoPath, doc.page.width / 2 - 50, 15, { height: 50 });
    } else {
      doc.fontSize(18).fillColor('#FFFFFF').text('SECTI', { align: 'center' });
    }
  } catch (e) {
    console.error('Erro ao carregar imagem do cabeçalho:', e);
  }
  doc.y = 100;
}

function generateFooter(doc, token) {
  const y = doc.y;
  const govLogoPath = path.join(__dirname, '..', '..', 'public', 'images', 'logo-governo.png');
  const pageHeight = doc.page.height;
  doc.rect(0, pageHeight - 70, doc.page.width, 70).fill('#004480');
  try {
    if (fs.existsSync(govLogoPath)) {
      doc.image(govLogoPath, doc.page.width - 120, pageHeight - 55, { height: 40 });
    }
  } catch (e) {
    console.error('Erro ao carregar imagem do rodapé:', e);
  }
  if (token) {
    doc
      .fillColor('#fff')
      .fontSize(8)
      .text(`Token: ${token}`, doc.page.margins.left, pageHeight - 50);
  }
  doc.y = y;
}

function generateTable(doc, data) {
  let y = doc.y;
  const rowHeight = 30;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = {
    nome: availableWidth * 0.3,
    cnpj: availableWidth * 0.2,
    email: availableWidth * 0.25,
    telefone: availableWidth * 0.15,
    sala: availableWidth * 0.1,
  };
  const headers = ['Razão Social', 'CNPJ', 'E-mail', 'Telefone', 'Sala(s)'];

  const drawRow = (row, currentY, isHeader = false) => {
    let x = doc.page.margins.left;
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(isHeader ? 9 : 8);
    row.forEach((cell, i) => {
      const key = Object.keys(colWidths)[i];
      doc.text(String(cell), x + 5, currentY + 10, {
        width: colWidths[key] - 10,
        align: 'left',
        lineBreak: true,
      });
      doc.rect(x, currentY, colWidths[key], rowHeight).stroke('#ccc');
      x += colWidths[key];
    });
  };

  drawRow(headers, y, true);
  y += rowHeight;

  for (const item of data) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 70) {
      doc.addPage();
      y = 100;
      drawRow(headers, y, true);
      y += rowHeight;
    }
    const row = [
      item.nome_empresa,
      item.cnpj,
      item.email,
      item.telefone || 'N/A',
      item.numero_sala,
    ];
    drawRow(row, y);
    y += rowHeight;
  }
}

function generateDebtorsTable(doc, data) {
  let y = doc.y;
  const rowHeight = 30;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = {
    nome: availableWidth * 0.45,
    cnpj: availableWidth * 0.2,
    quantidade: availableWidth * 0.15,
    total: availableWidth * 0.2,
  };
  const headers = ['Razão Social', 'CNPJ', 'Qtde DARs', 'Total Devido (R$)'];

  const drawRow = (row, currentY, isHeader = false) => {
    let x = doc.page.margins.left;
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(isHeader ? 9 : 8);
    row.forEach((cell, i) => {
      const key = Object.keys(colWidths)[i];
      doc.text(String(cell), x + 5, currentY + 10, {
        width: colWidths[key] - 10,
        align: 'left',
        lineBreak: true,
      });
      doc.rect(x, currentY, colWidths[key], rowHeight).stroke('#ccc');
      x += colWidths[key];
    });
  };

  drawRow(headers, y, true);
  y += rowHeight;

  for (const item of data) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 70) {
      doc.addPage();
      y = 100;
      drawRow(headers, y, true);
      y += rowHeight;
    }
    const row = [
      item.nome_empresa,
      item.cnpj,
      item.quantidade_dars,
      Number(item.total_devido).toFixed(2),
    ];
    drawRow(row, y);
    y += rowHeight;
  }
}

module.exports = router;
