// src/api/adminDarsRoutes.js
const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { notificarDarGerado } = require('../services/notificacaoService');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { isoHojeLocal, toISO, buildSefazPayloadPermissionario } = require('../utils/sefazPayload');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const db = require('../database/db');

const fs = require('fs');
const path = require('path');

const router = express.Router();

// Helpers async
const dbGetAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAllAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRunAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));

/**
 * GET /api/admin/dars
 * Lista paginada com filtros (nome/CNPJ, status, mês, ano)
 */
router.get(
  '/',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const search = String(req.query.search || '').trim();
      const status = String(req.query.status || 'todos').trim();
      const mes = String(req.query.mes || 'todos').trim();
      const ano = String(req.query.ano || 'todos').trim();

      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.max(1, parseInt(req.query.limit || '10', 10));
      const offset = (page - 1) * limit;

      let baseSql = `
        SELECT 
          d.id, d.mes_referencia, d.ano_referencia, d.valor,
          d.data_vencimento, d.data_pagamento, d.status,
          d.numero_documento, d.pdf_url,
          p.nome_empresa, p.cnpj
        FROM dars d
        JOIN permissionarios p ON d.permissionario_id = p.id
        WHERE 1=1
      `;
      const params = [];

      if (search) {
        baseSql += ` AND (p.nome_empresa LIKE ? OR p.cnpj LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
      if (status && status !== 'todos') {
        if (['vencido', 'vencida'].includes(status.toLowerCase())) {
          baseSql += ` AND d.status IN (?, ?)`;
          params.push('Vencido', 'Vencida');
        } else {
          baseSql += ` AND d.status = ?`;
          params.push(status);
        }
      }
      if (mes && mes !== 'todos') {
        baseSql += ` AND d.mes_referencia = ?`;
        params.push(mes);
      }
      if (ano && ano !== 'todos') {
        baseSql += ` AND d.ano_referencia = ?`;
        params.push(ano);
      }

      const countSql = `SELECT COUNT(*) as total FROM (${baseSql}) AS src`;
      const { total } = await dbGetAsync(countSql, params);
      const totalPages = Math.ceil(total / limit);

      const pageSql = `${baseSql} ORDER BY d.ano_referencia DESC, d.mes_referencia DESC, p.nome_empresa LIMIT ? OFFSET ?`;
      const rows = await dbAllAsync(pageSql, [...params, limit, offset]);

      return res.status(200).json({
        dars: rows,
        totalPages,
        currentPage: page,
        totalItems: total
      });
    } catch (err) {
      console.error('[AdminDARs] ERRO GET /api/admin/dars:', err);
      return res.status(500).json({ error: 'Erro ao buscar os DARs.' });
    }
  }
);

/**
 * POST /api/admin/dars/:id/enviar-notificacao
 * Envia e-mail (com fallback) para o permissionário daquele DAR.
 */
router.post(
  '/:id/enviar-notificacao',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = req.params.id;

      const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ?`, [darId]);
      if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

      const perm = await dbGetAsync(`SELECT * FROM permissionarios WHERE id = ?`, [dar.permissionario_id]);
      if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

      const ok = await notificarDarGerado(perm, dar, { tipo: 'notificar' });
      if (!ok) {
        return res.status(400).json({
          error: 'Permissionário não possui e-mail de notificação, financeiro ou principal cadastrado.'
        });
      }
      return res.status(200).json({ message: 'E-mail de notificação enviado com sucesso!' });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /:id/enviar-notificacao:', err);
      return res.status(500).json({ error: 'Falha ao enviar o e-mail.' });
    }
  }
);

/**
 * POST /api/admin/dars/:id/emitir
 * Emite a guia na SEFAZ pelo admin (independe do usuário logado ser o permissionário).
 */
router.post(
  '/:id/emitir',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = req.params.id;

      const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ?`, [darId]);
      if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

      const perm = await dbGetAsync(`SELECT * FROM permissionarios WHERE id = ?`, [dar.permissionario_id]);
      if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

      // Ajuste de vencimento/valor se estiver vencido + garantir data >= hoje
      let guiaSource = { ...dar };
      if (dar.status === 'Vencido' || dar.status === 'Vencida') {
        const calculo = await calcularEncargosAtraso(dar);
        guiaSource.valor = calculo.valorAtualizado;
        guiaSource.data_vencimento = calculo.novaDataVencimento || isoHojeLocal();
      }
      if (toISO(guiaSource.data_vencimento) < isoHojeLocal()) {
        guiaSource.data_vencimento = isoHojeLocal();
      }

      // Monta payload e emite
      const payload = buildSefazPayloadPermissionario({ perm, darLike: guiaSource });
      const sefazResponse = await emitirGuiaSefaz(payload);

      if (!sefazResponse || !sefazResponse.numeroGuia || !sefazResponse.pdfBase64) {
        throw new Error('Retorno da SEFAZ incompleto.');
      }

      const tokenDoc = await gerarTokenDocumento('DAR', dar.permissionario_id, db);
      sefazResponse.pdfBase64 = await imprimirTokenEmPdf(sefazResponse.pdfBase64, tokenDoc);

      // Persiste número/pdf e marca como Emitido (compat com campos antigos)
      await dbRunAsync(
        `UPDATE dars
           SET numero_documento = ?,
               pdf_url = ?,
               codigo_barras = COALESCE(?, codigo_barras),
               link_pdf      = COALESCE(?, link_pdf),
               status = 'Emitido'
         WHERE id = ?`,
        [
          sefazResponse.numeroGuia,
          sefazResponse.pdfBase64,
          sefazResponse.numeroGuia, // compat
          sefazResponse.pdfBase64,  // compat
          darId
        ]
      );
      return res.status(200).json({ ...sefazResponse, token: tokenDoc });
    } catch (error) {
      console.error('[AdminDARs] ERRO POST /:id/emitir:', error);
      const isUnavailable =
        /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
          error.message || ''
        );
      const status = isUnavailable ? 503 : 500;
      return res.status(status).json({ error: error.message || 'Erro interno do servidor.' });
    }
  }
);

/**
 * POST /api/admin/dars/:id/reemitir
 * Reemite a guia na SEFAZ permitindo atualizar valor e vencimento.
 */
router.post(
  '/:id/reemitir',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = req.params.id;
      const { valor, data_vencimento } = req.body || {};

      const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ?`, [darId]);
      if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

      const perm = await dbGetAsync(`SELECT * FROM permissionarios WHERE id = ?`, [dar.permissionario_id]);
      if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

      // Base para emissão
      let guiaSource = { ...dar };

      // Recalcula encargos de atraso se possível
      if (calcularEncargosAtraso) {
        try {
          const calc = await calcularEncargosAtraso(dar);
          guiaSource.valor = calc?.valorAtualizado ?? guiaSource.valor;
          guiaSource.data_vencimento = calc?.novaDataVencimento ?? guiaSource.data_vencimento;
        } catch (e) {
          console.warn('[AdminDARs] Falha em calcular encargos:', e.message);
        }
      }

      // Sobrescreve com valores enviados no body, se houver
      if (valor) guiaSource.valor = valor;
      if (data_vencimento) guiaSource.data_vencimento = data_vencimento;

      // Garantir vencimento >= hoje
      if (toISO(guiaSource.data_vencimento) < isoHojeLocal()) {
        guiaSource.data_vencimento = isoHojeLocal();
      }

      // Monta payload e reemite
      const payload = buildSefazPayloadPermissionario({ perm, darLike: guiaSource });
      const sefazResponse = await emitirGuiaSefaz(payload);

      if (!sefazResponse || !sefazResponse.numeroGuia || !sefazResponse.pdfBase64) {
        throw new Error('Retorno da SEFAZ incompleto.');
      }

      const tokenDoc = await gerarTokenDocumento('DAR', dar.permissionario_id, db);
      sefazResponse.pdfBase64 = await imprimirTokenEmPdf(sefazResponse.pdfBase64, tokenDoc);

      // Atualiza DAR com novos valores e dados da emissão
      await dbRunAsync(
        `UPDATE dars
           SET valor = ?,
               data_vencimento = ?,
               numero_documento = ?,
               pdf_url = ?,
               codigo_barras = COALESCE(?, codigo_barras),
               link_pdf      = COALESCE(?, link_pdf),
               status = 'Reemitido'
         WHERE id = ?`,
        [
          guiaSource.valor,
          guiaSource.data_vencimento,
          sefazResponse.numeroGuia,
          sefazResponse.pdfBase64,
          sefazResponse.numeroGuia,
          sefazResponse.pdfBase64,
          darId
        ]
      );

      return res.status(200).json({ ...sefazResponse, token: tokenDoc });
    } catch (error) {
      console.error('[AdminDARs] ERRO POST /:id/reemitir:', error);
      const isUnavailable =
        /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
          error.message || ''
        );
      const status = isUnavailable ? 503 : 500;
      return res.status(status).json({ error: error.message || 'Erro interno do servidor.' });
    }
  }
);

/**
 * GET /api/admin/dars/:id/pdf
 * Retorna o PDF (base64, URL absoluta ou caminho relativo).
 */
router.get(
  '/:id/pdf',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const dar = await dbGetAsync('SELECT * FROM dars WHERE id = ?', [id]);
      if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

      const pdf = dar.pdf_url || dar.link_pdf || '';
      if (!pdf || String(pdf).length < 20) {
        return res.status(404).json({ error: 'PDF indisponível para este DAR.' });
      }

      // base64 direto?
      const isBase64Pdf =
        typeof pdf === 'string' &&
        (/^JVBER/i.test(pdf) || /^data:application\/pdf;base64,/i.test(pdf));
      if (isBase64Pdf) {
        const base64 = String(pdf).replace(/^data:application\/pdf;base64,/i, '');
        const buf = Buffer.from(base64, 'base64');
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="DAR-${dar.numero_documento || id}.pdf"`);
        return res.send(buf);
      }

      // URL absoluta?
      if (/^https?:\/\//i.test(pdf)) {
        return res.redirect(302, pdf);
      }

      // Caminho relativo? (usa base pública, ou stream do disco)
      const rel = String(pdf).replace(/^\/+/, '');
      const base = (process.env.ADMIN_PUBLIC_BASE || '').replace(/\/$/, '');
      if (base) return res.redirect(302, `${base}/${rel}`);

      const fsPath = path.join(process.env.UPLOADS_DIR || 'uploads', rel);
      if (!fs.existsSync(fsPath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }
      res.type('application/pdf');
      return fs.createReadStream(fsPath).pipe(res);
    } catch (err) {
      console.error('[AdminDARs] ERRO GET /:id/pdf:', err);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  }
);


module.exports = router;
