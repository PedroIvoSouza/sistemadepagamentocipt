// src/api/adminDarsRoutes.js
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { notificarDarGerado } = require('../services/notificacaoService');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { isoHojeLocal, toISO, buildSefazPayloadPermissionario } = require('../utils/sefazPayload');

const router = express.Router();

// Usa o caminho definido no .env (SQLITE_STORAGE) com fallback
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
console.log(`[AdminDARs] Abrindo SQLite em: ${DB_PATH}`);
const db = new sqlite3.Database(DB_PATH);

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

      return res.status(200).json(sefazResponse);
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

module.exports = router;