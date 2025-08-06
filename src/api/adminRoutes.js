const express = require('express');
const sqlite3 = require('sqlite3').verbose();
// --- MUDANÇA 1: Importando os novos middlewares ---
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
// ----------------------------------------------------
const { Parser } = require('json2csv');
const xlsx = require('xlsx');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// Funções auxiliares para facilitar as consultas ao banco
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

// --- MUDANÇA 2: Atualizando a proteção da rota ---
// ROTA 1: GET /api/admin/dashboard-stats
router.get('/dashboard-stats', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], async (req, res) => {
  try {
    const totalPermissionarios = (await dbGet(
      `SELECT COUNT(*) as count FROM permissionarios`
    )).count;
    const darsPendentes = (await dbGet(
      `SELECT COUNT(*) as count FROM dars WHERE status = 'Pendente'`
    )).count;
    const darsVencidos = (await dbGet(
      `SELECT COUNT(*) as count FROM dars WHERE status = 'Vencido'`
    )).count;
    const receitaPendente =
      (await dbGet(
        `SELECT SUM(valor) as sum FROM dars WHERE status = 'Pendente' OR status = 'Vencido'` // Corrigido para incluir vencidos
      )).sum || 0;

    const resumoMensal = await dbAll(
      `
      SELECT
        ano_referencia,
        mes_referencia,
        COUNT(*) as emitidas,
        SUM(CASE WHEN status = 'Pago' THEN 1 ELSE 0 END) as pagas,
        SUM(CASE WHEN status = 'Vencido' THEN 1 ELSE 0 END) as vencidas
      FROM dars
      GROUP BY ano_referencia, mes_referencia
      ORDER BY ano_referencia DESC, mes_referencia DESC
      LIMIT 6
    `
    );

    const maioresDevedores = await dbAll(
      `
      SELECT
        p.nome_empresa,
        SUM(d.valor) as total_devido
      FROM dars d
      JOIN permissionarios p ON p.id = d.permissionario_id
      WHERE d.status IN ('Pendente','Vencido')
      GROUP BY p.id, p.nome_empresa
      ORDER BY total_devido DESC
      LIMIT 5
    `
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
    res
      .status(500)
      .json({ error: 'Erro ao buscar as estatísticas do dashboard.' });
  }
});

// --- MUDANÇA 3: Atualizando a proteção das rotas de permissionários ---
// ROTA 2: GET /api/admin/permissionarios
router.get('/permissionarios', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], async (req, res) => {
  // ... (o resto do código da rota continua igual)
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [];
    if (search) {
      whereClause = `WHERE nome_empresa LIKE ? OR cnpj LIKE ?`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const countSql = `SELECT COUNT(*) as count FROM permissionarios ${whereClause}`;
    const totalResult = await dbGet(countSql, params);
    const totalPermissionarios = totalResult.count;

    const dataSql = `
      SELECT
        id, nome_empresa, cnpj, email, telefone, numero_sala
      FROM permissionarios
      ${whereClause}
      ORDER BY nome_empresa ASC
      LIMIT ? OFFSET ?
    `;
    const permissionarios = await dbAll(dataSql, [
      ...params,
      limit,
      offset,
    ]);

    res.status(200).json({
      permissionarios,
      totalPages: Math.ceil(totalPermissionarios / limit),
      currentPage: Number(page),
    });
  } catch (error) {
    console.error('Erro ao buscar permissionários:', error);
    res
      .status(500)
      .json({ error: 'Erro ao buscar a lista de permissionários.' });
  }
});

// ROTA 3: GET /api/admin/permissionarios/:id
router.get('/permissionarios/:id', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], async (req, res) => {
    // ... (o resto do código da rota continua igual)
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
        console.error(
          'Erro na rota GET /permissionarios/:id:',
          error
        );
        res
          .status(500)
          .json({ error: 'Erro ao buscar dados do permissionário.' });
      }
});

// ROTA 4: PUT /api/admin/permissionarios/:id
router.put('/permissionarios/:id', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], async (req, res) => {
    // ... (o resto do código da rota continua igual)
    const { id } = req.params;
    const {
        nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel,
      } = req.body;
    // ... (validações)
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
});

// ROTA 5: POST /api/admin/permissionarios
router.post('/permissionarios', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], async (req, res) => {
    // ... (o resto do código da rota continua igual)
    const {
        nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel,
      } = req.body;
      // ... (validações)
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
                return reject(
                  new Error('CNPJ ou E-mail já cadastrado no sistema.')
                );
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
});

// ROTA 6: GET /api/admin/permissionarios/export/:format
router.get(
  '/permissionarios/export/:format',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], // <--- CORREÇÃO APLICADA
  async (req, res) => {
    try {
      const { format } = req.params;
      const { search = '' } = req.query;

      let whereClause = '';
      const params = [];
      if (search) {
        whereClause = `WHERE nome_empresa LIKE ? OR cnpj LIKE ?`;
        params.push(`%${search}%`, `%${search}%`);
      }

      const permissionarios = await dbAll(
        `
        SELECT
          nome_empresa,
          cnpj,
          email,
          telefone,
          numero_sala
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
        const buf = xlsx.write(wb, {
          bookType: 'xlsx',
          type: 'buffer',
        });
        res.header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.attachment('permissionarios.xlsx');
        return res.send(buf);
      }

      // PDF
      if (format === 'pdf') {
        const doc = new PDFDocument({
          layout: 'landscape',
          size: 'A4',
          margins: { top: 50, bottom: 50, left: 50, right: 50 },
        });
        res.header('Content-Type', 'application/pdf');
        res.attachment('permissionarios.pdf');
        doc.pipe(res);

        doc.on('pageAdded', () => {
          generateHeader(doc);
          generateFooter(doc);
        });

        generateHeader(doc);
        generateFooter(doc);
        doc.fillColor('#333').fontSize(16).text('Relatório de Permissionários', {
          align: 'center',
        });
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

// FUNÇÕES AUXILIARES PARA PDF
function generateHeader(doc) {
  const sectiLogoPath = path.join(
    __dirname,
    '..',
    '..',
    'public',
    'images',
    'LOGO SECTI.png'
  );
  doc.rect(0, 0, doc.page.width, 80).fill('#0056a0');
  try {
    if (fs.existsSync(sectiLogoPath)) {
      doc.image(sectiLogoPath, doc.page.width / 2 - 50, 15, {
        height: 50,
      });
    } else {
      doc.fontSize(18).fillColor('#FFFFFF').text('SECTI', {
        align: 'center',
      });
    }
  } catch (e) {
    console.error('Erro ao carregar imagem do cabeçalho:', e);
  }
  doc.y = 100;
}

function generateFooter(doc) {
  const govLogoPath = path.join(
    __dirname,
    '..',
    '..',
    'public',
    'images',
    'logo-governo.png'
  );
  const pageHeight = doc.page.height;
  doc.rect(0, pageHeight - 70, doc.page.width, 70).fill('#004480');
  try {
    if (fs.existsSync(govLogoPath)) {
      doc.image(govLogoPath, doc.page.width - 120, pageHeight - 55, {
        height: 40,
      });
    }
  } catch (e) {
    console.error('Erro ao carregar imagem do rodapé:', e);
  }
}

function generateTable(doc, data) {
  let y = 140;
  const rowHeight = 30;
  const colWidths = {
    nome: 230,
    cnpj: 120,
    email: 170,
    telefone: 100,
    sala: 80,
  };
  const headers = ['Razão Social', 'CNPJ', 'E-mail', 'Telefone', 'Sala(s)'];

  const drawRow = (row, currentY, isHeader = false) => {
    let x = doc.page.margins.left;
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(
      isHeader ? 9 : 8
    );
    row.forEach((cell, i) => {
      const key = Object.keys(colWidths)[i];
      doc.text(cell.toString(), x + 5, currentY + 10, {
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

module.exports = router;
