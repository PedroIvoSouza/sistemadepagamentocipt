// src/api/adminRoutes.js
const express = require('express');
const { Parser } = require('json2csv');
const xlsx = require('xlsx');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { gerarTokenDocumento } = require('../utils/token');
const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');

// Middlewares
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const router = express.Router();
const db = require('../database/db');

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
   ========================= */
async function ensureIndexes() {
  try {
    await dbRun(`PRAGMA journal_mode = WAL;`);
  } catch {}

  const tableInfo = await dbAll(`PRAGMA table_info(dars);`);
  if (!tableInfo || tableInfo.length === 0) {
    console.warn('[ensureIndexes] Tabela "dars" não encontrada; índices não serão criados.');
    return;
  }

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_status             ON dars(status);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_data_vencimento    ON dars(data_vencimento);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_status_venc        ON dars(status, data_vencimento);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_dars_permissionario     ON dars(permissionario_id);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_perm_nome               ON permissionarios(nome_empresa);`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_perm_cnpj               ON permissionarios(cnpj);`);

  console.log('[ensureIndexes] Índices criados/verificados.');
}

// export for external invocation

// Status em aberto (considera masculino e feminino)
const OPEN_STATUSES = `('Pendente','Emitido','Emitida','Vencido','Vencida')`;

/* ===========================================================
   GET /api/admin/dashboard-stats
   =========================================================== */
router.get(
  '/dashboard-stats',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { tipo } = req.query || {};
      let whereTipo = '';
      if (tipo === 'permissionarios') {
        whereTipo = "AND (d.tipo_permissionario IS NULL OR d.tipo_permissionario != 'Evento')";
      } else if (tipo === 'eventos') {
        whereTipo = "AND d.tipo_permissionario = 'Evento'";
      }
      const ignoreIsentos =
        "AND (d.permissionario_id IS NULL OR ((p.tipo IS NULL OR p.tipo != 'Isento') AND COALESCE(p.valor_aluguel,0) > 0))";

      // Total de permissionários
      const totalPermissionarios = (await dbGet(
        `SELECT COUNT(*) AS count FROM permissionarios`
      )).count;

      // Cards do topo: DARs pendentes e Receita pendente (tudo em aberto)
      const pendRow = await dbGet(
        `SELECT COUNT(*) AS qnt, COALESCE(SUM(d.valor),0) AS valor
           FROM dars d
           LEFT JOIN permissionarios p ON p.id = d.permissionario_id
          WHERE d.status IN ${OPEN_STATUSES} ${whereTipo} ${ignoreIsentos}`
      );
      const darsPendentes   = pendRow?.qnt ?? 0;
      const receitaPendente = Number(pendRow?.valor ?? 0);

      // Card: DARs vencidas (em horário local)
      const vencRow = await dbGet(
        `SELECT COUNT(*) AS qnt
           FROM dars d
           LEFT JOIN permissionarios p ON p.id = d.permissionario_id
          WHERE d.status IN ${OPEN_STATUSES}
            AND DATE(d.data_vencimento) < DATE('now','localtime')
            ${whereTipo} ${ignoreIsentos}`
      );
      const darsVencidos = vencRow?.qnt ?? 0;

      // Resumo mensal por mês de vencimento (não por competência)
         const resumoMensal = await dbAll(`
           SELECT
             CAST(strftime('%Y', d.data_vencimento) AS INTEGER) AS ano,
             CAST(strftime('%m', d.data_vencimento) AS INTEGER) AS mes,
             COUNT(*) AS emitidas,
             SUM(CASE WHEN d.status = 'Pago' THEN 1 ELSE 0 END) AS pagas,
             SUM(CASE
                   WHEN d.status IN ${OPEN_STATUSES}
                    AND DATE(d.data_vencimento) < DATE('now','localtime')
                 THEN 1 ELSE 0 END) AS vencidas,
             SUM(CASE
                   WHEN d.status IN ${OPEN_STATUSES}
                    AND DATE(d.data_vencimento) >= DATE('now','localtime')
                 THEN 1 ELSE 0 END) AS a_vencer
           FROM dars d
           LEFT JOIN permissionarios p ON p.id = d.permissionario_id
           WHERE 1=1 ${whereTipo} ${ignoreIsentos}
           GROUP BY ano, mes
           ORDER BY ano DESC, mes DESC
           LIMIT 6
         `);

      // Maiores devedores (todas as competências)
      // Ranking por QUANTIDADE de DARs em aberto; chip mostra SOMENTE o valor vencido
      const maioresDevedores = await dbAll(
        `SELECT
            p.nome_empresa,
            COUNT(*) AS qtd_debitos,  -- DARs em aberto (pendente/emitido/emitida/vencido/vencida)
            SUM(CASE WHEN DATE(d.data_vencimento) < DATE('now','localtime') THEN 1 ELSE 0 END) AS qtd_vencidos,
            COALESCE(SUM(d.valor), 0) AS total_aberto,  -- vencido + a vencer
            COALESCE(SUM(CASE
                    WHEN DATE(d.data_vencimento) < DATE('now','localtime')
                    THEN d.valor ELSE 0 END), 0) AS total_vencido,  -- só vencido
            -- aliases usados pelo front para o "badge" vermelho:
            COALESCE(SUM(CASE
                    WHEN DATE(d.data_vencimento) < DATE('now','localtime')
                    THEN d.valor ELSE 0 END), 0) AS total_devido,
            COALESCE(SUM(CASE
                    WHEN DATE(d.data_vencimento) < DATE('now','localtime')
                    THEN d.valor ELSE 0 END), 0) AS valor
         FROM dars d
         JOIN permissionarios p ON p.id = d.permissionario_id
         WHERE d.status IN ${OPEN_STATUSES}
           AND d.permissionario_id IS NOT NULL
           ${whereTipo}
           AND (p.tipo IS NULL OR p.tipo != 'Isento') AND COALESCE(p.valor_aluguel,0) > 0
         GROUP BY p.id, p.nome_empresa
         HAVING COUNT(*) > 0
         ORDER BY qtd_debitos DESC, total_vencido DESC
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
   Rotas de Permissionários
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
        SELECT id, nome_empresa, cnpj, email, telefone, telefone_cobranca, numero_sala, tipo
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
      nome_empresa,
      cnpj,
      email,
      telefone,
      telefone_cobranca,
      numero_sala,
      valor_aluguel,
      tipo,
    } = req.body;

    try {
      const sql = `
        UPDATE permissionarios SET
          nome_empresa = ?, cnpj = ?, email = ?, telefone = ?, telefone_cobranca = ?, numero_sala = ?, valor_aluguel = ?, tipo = ?
        WHERE id = ?
      `;
      const params = [
        nome_empresa,
        cnpj,
        email,
        telefone,
        telefone_cobranca,
        numero_sala,
        valor_aluguel,
        tipo,
        id,
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
      nome_empresa,
      cnpj,
      email,
      telefone,
      telefone_cobranca,
      numero_sala,
      valor_aluguel,
      tipo,
    } = req.body;

    try {
      const sql = `
        INSERT INTO permissionarios
          (nome_empresa, cnpj, email, telefone, telefone_cobranca, numero_sala, valor_aluguel, tipo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const params = [
        nome_empresa,
        cnpj,
        email,
        telefone,
        telefone_cobranca,
        numero_sala,
        valor_aluguel,
        tipo,
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
   Exportações (CSV, XLSX, PDF)
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
        SELECT nome_empresa, cnpj, email, telefone, telefone_cobranca, numero_sala, tipo
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
        const tokenDoc = await gerarTokenDocumento('RELATORIO_PERMISSIONARIOS', null, db);

        const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5) });
        res.header('Content-Type', 'application/pdf');
        res.attachment('permissionarios.pdf');
        res.setHeader('X-Document-Token', tokenDoc);
        doc.pipe(res);

        // Papel timbrado em todas as páginas
        applyLetterhead(doc, { imagePath: path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png') });

        // Cursor inicial dentro da área útil
        doc.x = doc.page.margins.left;
        doc.y = doc.page.margins.top;

        // Token por página (sem mover o cursor do conteúdo)
        printToken(doc, tokenDoc);
        doc.on('pageAdded', () => printToken(doc, tokenDoc));

        // Conteúdo
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
   GET /api/admin/relatorios/pagamentos
   =========================================================== */
router.get(
  '/relatorios/pagamentos',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const mes = parseInt(req.query.mes, 10);
      const ano = parseInt(req.query.ano, 10);
      const { tipo } = req.query || {};

      if (!mes || mes < 1 || mes > 12 || !ano) {
        return res.status(400).json({ error: 'Parâmetros mes e ano são obrigatórios e devem ser válidos.' });
      }

      let tipoWhere = '';
      const paramsPagos = [mes, ano];
      if (tipo) {
        tipoWhere = ' AND p.tipo = ?';
        paramsPagos.push(tipo);
      }
      const pagos = await dbAll(
        `SELECT d.permissionario_id, p.nome_empresa, p.cnpj, p.tipo, SUM(d.valor) AS valor
           FROM dars d
           JOIN permissionarios p ON p.id = d.permissionario_id
          WHERE d.mes_referencia = ?
            AND d.ano_referencia = ?
            AND d.status = 'Pago'
            AND (p.tipo IS NULL OR p.tipo != 'Isento')
            AND COALESCE(p.valor_aluguel,0) > 0${tipoWhere}
          GROUP BY d.permissionario_id, p.nome_empresa, p.cnpj, p.tipo`,
        paramsPagos
      );

      const paramsDev = [mes, ano];
      if (tipo) paramsDev.push(tipo);
      const devedores = await dbAll(
        `SELECT d.permissionario_id, p.nome_empresa, p.cnpj, p.tipo, SUM(d.valor) AS valor
           FROM dars d
           JOIN permissionarios p ON p.id = d.permissionario_id
          WHERE d.mes_referencia = ?
            AND d.ano_referencia = ?
            AND d.status IN ${OPEN_STATUSES}
            AND (p.tipo IS NULL OR p.tipo != 'Isento')
            AND COALESCE(p.valor_aluguel,0) > 0${tipoWhere}
          GROUP BY d.permissionario_id, p.nome_empresa, p.cnpj, p.tipo`,
        paramsDev
      );

      res.status(200).json({ pagos, devedores });
    } catch (error) {
      console.error('Erro ao gerar relatório de pagamentos:', error);
      res.status(500).json({ error: 'Erro ao gerar relatório de pagamentos.' });
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
      const { tipo } = req.query || {};
      const params = [];
      let tipoWhere = '';
      if (tipo) {
        tipoWhere = ' AND p.tipo = ?';
        params.push(tipo);
      }

      const devedores = await dbAll(
        `SELECT
            p.nome_empresa,
            p.cnpj,
            p.tipo,
            COUNT(d.id)  AS quantidade_dars,
            SUM(d.valor) AS total_devido
         FROM dars d
         JOIN permissionarios p ON p.id = d.permissionario_id
         WHERE d.status <> 'Pago'
           AND DATE(d.data_vencimento) < DATE('now')
           ${tipoWhere}
         GROUP BY p.id, p.nome_empresa, p.cnpj, p.tipo
           AND (p.tipo IS NULL OR p.tipo != 'Isento') AND COALESCE(p.valor_aluguel,0) > 0
         GROUP BY p.id, p.nome_empresa, p.cnpj
         HAVING total_devido > 0
         ORDER BY total_devido DESC`,
        params
      );

      if (!devedores.length) {
        return res.status(404).json({ error: 'Nenhum devedor encontrado.' });
      }

      const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5) });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secti-'));
      const filePath = path.join(tmpDir, `relatorio_devedores_${Date.now()}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const tokenDoc = await gerarTokenDocumento('RELATORIO_DEVEDORES', null, db);

      // Papel timbrado em todas as páginas
      applyLetterhead(doc, { imagePath: path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png') });

      // Cursor inicial dentro da área útil
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;

      // Token por página (sem mover o cursor do conteúdo)
      printToken(doc, tokenDoc);
      doc.on('pageAdded', () => printToken(doc, tokenDoc));

      // Conteúdo
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
          fs.rm(tmpDir, { recursive: true }, () => {});
        });
      });
    } catch (error) {
      console.error('Erro ao gerar relatório devedores:', error);
      res.status(500).json({ error: 'Erro ao gerar o relatório de devedores.' });
    }
  }
);

/* ===========================================================
   GET /api/admin/relatorios/dars
   =========================================================== */
router.get(
  '/relatorios/dars',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const cols = await dbAll(`PRAGMA table_info(dars)`);
      const hasDataEmissao = cols.some(c => c.name === 'data_emissao');
      const emissaoSelect = hasDataEmissao ? 'd.data_emissao' : 'NULL';
      const orderBy = hasDataEmissao ? 'd.data_emissao' : 'd.id';

      const { tipo } = req.query || {};
      let whereTipo = '';
      const params = [];
      if (tipo) {
        whereTipo = ' AND COALESCE(p.tipo, "") = ?';
        params.push(tipo);
      }

      const dars = await dbAll(
        `SELECT
            COALESCE(p.nome_empresa, '') AS nome_empresa,
            COALESCE(p.cnpj, '') AS cnpj,
            COALESCE(p.tipo, '') AS tipo,
            d.numero_documento,
            d.valor,
            ${emissaoSelect} AS data_emissao,
            d.mes_referencia,
            d.ano_referencia
         FROM dars d
         LEFT JOIN permissionarios p ON p.id = d.permissionario_id
         WHERE d.status = 'Emitido'${whereTipo}
           AND (d.permissionario_id IS NULL OR ((p.tipo IS NULL OR p.tipo != 'Isento')
                AND COALESCE(p.valor_aluguel,0) > 0))
         ORDER BY ${orderBy} DESC`,
        params
      );

      if (!dars.length) {
        return res.status(204).send();
      }

      const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5) });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secti-'));
      const filePath = path.join(tmpDir, `relatorio_dars_${Date.now()}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const tokenDoc = await gerarTokenDocumento('RELATORIO_DARS', null, db);

      applyLetterhead(doc, { imagePath: path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png') });

      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;

      printToken(doc, tokenDoc);
      doc.on('pageAdded', () => printToken(doc, tokenDoc));

      doc.fillColor('#333').fontSize(16).text('Relatório de DARs', { align: 'center' });
      doc.moveDown(2);
      generateDarsTable(doc, dars);
      doc.end();

      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      await dbRun(
        `INSERT INTO documentos (tipo, caminho, token) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET caminho = excluded.caminho`,
        ['RELATORIO_DARS', filePath, tokenDoc]
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio_dars.pdf"');
      res.setHeader('X-Document-Token', tokenDoc);
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      fileStream.on('close', () => {
        fs.unlink(filePath, () => {
          fs.rm(tmpDir, { recursive: true }, () => {});
        });
      });
    } catch (error) {
      console.error('Erro ao gerar relatório de DARs:', error);
      res.status(500).json({ error: 'Erro ao gerar o relatório de DARs.' });
    }
  }
);

/* ===========================================================
   GET /api/admin/relatorios/eventos-dars
   =========================================================== */
router.get(
  '/relatorios/eventos-dars',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { dataInicio, dataFim } = req.query;
      if (!dataInicio || !dataFim) {
        return res.status(400).json({ error: 'Parâmetros dataInicio e dataFim são obrigatórios.' });
      }

      const dars = await dbAll(
        `SELECT e.nome_evento, c.nome_razao_social AS cliente, d.numero_documento,
                d.data_vencimento, d.valor
           FROM DARs_Eventos de
           JOIN dars d ON d.id = de.id_dar
           JOIN Eventos e ON e.id = de.id_evento
           JOIN Clientes_Eventos c ON c.id = e.id_cliente
          WHERE d.status = 'Emitido' AND DATE(d.data_vencimento) BETWEEN ? AND ?
          ORDER BY d.data_vencimento`,
        [dataInicio, dataFim]
      );

      if (!dars.length) {
        return res.status(204).send();
      }

      const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5) });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secti-'));
      const filePath = path.join(tmpDir, `relatorio_eventos_dars_${Date.now()}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const tokenDoc = await gerarTokenDocumento('RELATORIO_EVENTOS_DARS', null, db);

      applyLetterhead(doc, { imagePath: path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png') });

      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
      printToken(doc, tokenDoc);
      doc.on('pageAdded', () => printToken(doc, tokenDoc));

      doc.fillColor('#333').fontSize(16).text('Relatório DARs de Eventos', { align: 'center' });
      doc.moveDown(2);
      generateEventoDarsTable(doc, dars);
      doc.end();

      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      await dbRun(
        `INSERT INTO documentos (tipo, caminho, token) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET caminho = excluded.caminho`,
        ['RELATORIO_EVENTOS_DARS', filePath, tokenDoc]
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio_eventos_dars.pdf"');
      res.setHeader('X-Document-Token', tokenDoc);
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      fileStream.on('close', () => {
        fs.unlink(filePath, () => {
          fs.rm(tmpDir, { recursive: true }, () => {});
        });
      });
    } catch (error) {
      console.error('Erro ao gerar relatório de DARs de eventos:', error);
      res.status(500).json({ error: 'Erro ao gerar o relatório de DARs de eventos.' });
    }
  }
);

/* ===========================================================
   Render helpers (tabelas + token)
   =========================================================== */
function generateTable(doc, data) {
  let y = doc.y;
  const rowHeight = 30;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = {
    nome: availableWidth * 0.25,
    cnpj: availableWidth * 0.18,
    email: availableWidth * 0.22,
    telefone: availableWidth * 0.12,
    telefone_cobranca: availableWidth * 0.13,
    sala: availableWidth * 0.1,
  };
  const headers = ['Razão Social', 'CNPJ', 'E-mail', 'Telefone', 'Tel. Cobrança', 'Sala(s)'];

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
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top;   // reinicia na margem superior
      drawRow(headers, y, true);
      y += rowHeight;
    }
    const row = [
      item.nome_empresa,
      item.cnpj,
      item.email,
      item.telefone || 'N/A',
      item.telefone_cobranca || 'N/A',
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
    nome: availableWidth * 0.35,
    tipo: availableWidth * 0.15,
    cnpj: availableWidth * 0.2,
    quantidade: availableWidth * 0.15,
    total: availableWidth * 0.15,
  };
  const headers = ['Razão Social', 'Tipo', 'CNPJ', 'Qtde DARs', 'Total Devido (R$)'];

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
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top;   // reinicia na margem superior
      drawRow(headers, y, true);
      y += rowHeight;
    }
    const row = [
      item.nome_empresa,
      item.tipo || '',
      item.cnpj,
      item.quantidade_dars,
      Number(item.total_devido).toFixed(2),
    ];
    drawRow(row, y);
    y += rowHeight;
  }
}

function generateEventoDarsTable(doc, dados) {
  let y = doc.y;
  const rowHeight = 40;
  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = {
    evento: availableWidth * 0.30,
    cliente: availableWidth * 0.30,
    vencimento: availableWidth * 0.15,
    dar: availableWidth * 0.15,
    valor: availableWidth * 0.10,
  };
  const headers = ['Evento', 'Cliente', 'Vencimento', 'DAR', 'Valor (R$)'];

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

  for (const item of dados) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top; // reinicia na margem superior
      drawRow(headers, y, true);
      y += rowHeight;
    }
    const row = [
      item.nome_evento,
      item.cliente,
      item.data_vencimento
        ? new Date(item.data_vencimento).toLocaleDateString('pt-BR')
        : '',
      item.numero_documento,
      Number(item.valor).toFixed(2),
    ];
    drawRow(row, y);
    y += rowHeight;
  }
}

function generateDarsTable(doc, dados) {
  let y = doc.y;
  const rowHeight = 40;
  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = {
    empresa: availableWidth * 0.25,
    tipo: availableWidth * 0.15,
    cnpj: availableWidth * 0.15,
    emissao: availableWidth * 0.15,
    dar: availableWidth * 0.15,
    valor: availableWidth * 0.15,
  };
  const headers = ['Empresa', 'Tipo', 'CNPJ', 'Emissão', 'DAR/Comp.', 'Valor (R$)'];

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

  for (const item of dados) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top; // reinicia na margem superior
      drawRow(headers, y, true);
      y += rowHeight;
    }
    const numeroComp =
      item.numero_documento ||
      `${String(item.mes_referencia).padStart(2, '0')}/${item.ano_referencia}`;
    const row = [
      item.nome_empresa,
      item.tipo,
      item.cnpj,
      item.data_emissao ? new Date(item.data_emissao).toLocaleDateString('pt-BR') : '',
      numeroComp,
      Number(item.valor).toFixed(2),
    ];
    drawRow(row, y);
    y += rowHeight;
  }
}

function printToken(doc, token) {
  if (!token) return;

  // preserve o cursor do conteúdo
  const prevX = doc.x;
  const prevY = doc.y;

  doc.save();
  const x = doc.page.margins.left;
  const y = doc.page.height - doc.page.margins.bottom - 10; // dentro da área útil
  doc.fontSize(8).fillColor('#222').text(`Token: ${token}`, x, y, { lineBreak: false });
  doc.restore();

  // restaura o cursor do conteúdo
  doc.x = prevX;
  doc.y = prevY;
}

module.exports = router;
module.exports.ensureIndexes = ensureIndexes;
