// src/api/adminDarsRoutes.js
const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { notificarDarGerado } = require('../services/notificacaoService');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { isoHojeLocal, toISO } = require('../utils/sefazPayload');
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
// helper: pega contribuinte conforme DAR ser de permissionário OU de evento
async function getContribuinteEmitenteForDar(darId) {
  // 1) Busca a DAR
  const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ?`, [darId]);
  if (!dar) throw new Error('DAR não encontrada.');

  // 2) Se for por permissionário, pega do cadastro do permissionário
  if (dar.permissionario_id) {
    const perm = await dbGetAsync(`
      SELECT 
        nome_empresa                                     AS nome,
        COALESCE(NULLIF(TRIM(cnpj), ''), NULLIF(TRIM(cpf), '')) AS doc
      FROM permissionarios
      WHERE id = ?`, [dar.permissionario_id]);

    const nome = (perm?.nome || '').trim() || 'Contribuinte';
    let doc = String(perm?.doc || '').replace(/\D/g, '');
    // fallback: tenta outras colunas comuns, se existirem no schema
    if (!doc) {
      const alt = await dbGetAsync(`
        SELECT 
          COALESCE(NULLIF(TRIM(cnpj), ''), NULLIF(TRIM(cpf), '')) AS doc
        FROM permissionarios WHERE id = ?`, [dar.permissionario_id]);
      doc = String(alt?.doc || '').replace(/\D/g, '');
    }

    if (!(doc.length === 11 || doc.length === 14)) {
      throw new Error('Documento do permissionário ausente ou inválido.');
    }
    const tipo = (doc.length === 11) ? 3 : 4; // 3=CPF, 4=CNPJ

    return {
      codigoTipoInscricao: tipo,
      numeroInscricao: doc,
      nome,
      codigoIbgeMunicipio: 2704302,
      dar,
    };
  }

  // 3) Caso seja DAR de EVENTO, extrai do cliente do evento
  const ev = await dbGetAsync(`
    SELECT 
      COALESCE(NULLIF(TRIM(ce.nome_razao_social), ''), 'Contribuinte') AS nome,
      COALESCE(
        NULLIF(TRIM(ce.documento), ''),
        NULLIF(TRIM(ce.documento_responsavel), '')
      ) AS doc_raw
    FROM DARs_Eventos de
    JOIN Eventos e        ON e.id = de.id_evento
    JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
    WHERE de.id_dar = ?
    LIMIT 1`, [darId]);

  if (!ev) throw new Error('Evento/cliente do evento não encontrado.');

  const nome = ev.nome;
  let doc = String(ev.doc_raw || '').replace(/\D/g, '');

  // última tentativa: buscar direto no cliente, caso tenha ficado vazio
  if (!(doc.length === 11 || doc.length === 14)) {
    const ev2 = await dbGetAsync(`
      SELECT 
        COALESCE(
          NULLIF(TRIM(documento), ''),
          NULLIF(TRIM(documento_responsavel), '')
        ) AS doc2
      FROM Clientes_Eventos
      WHERE id = (SELECT e.id_cliente
                  FROM DARs_Eventos de 
                  JOIN Eventos e ON e.id = de.id_evento
                  WHERE de.id_dar = ? LIMIT 1)`, [darId]);
    doc = String(ev2?.doc2 || '').replace(/\D/g, '');
  }

  if (!(doc.length === 11 || doc.length === 14)) {
    throw new Error('Documento do cliente do evento ausente ou inválido.');
  }
  const tipo = (doc.length === 11) ? 3 : 4;

  return {
    codigoTipoInscricao: tipo,
    numeroInscricao: doc,
    nome,
    codigoIbgeMunicipio: 2704302,
    dar,
  };
}

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

// POST /api/admin/dars/:id/emitir
router.post(
  '/:id/emitir',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = Number(req.params.id);
      const { codigoTipoInscricao, numeroInscricao, nome, codigoIbgeMunicipio, dar } =
        await getContribuinteEmitenteForDar(darId);

      // 1) doc/tipo válidos
      const doc  = String(numeroInscricao || '').replace(/\D/g, '');
      if (doc.length !== 11 && doc.length !== 14) {
        return res.status(400).json({ error: 'Documento inválido (CPF 11 dígitos ou CNPJ 14).' });
      }
      const tipo = (doc.length === 11) ? 3 : 4; // 3=CPF, 4=CNPJ

      // 2) dados da guia
      const mes  = dar.mes_referencia || Number(String(dar.data_vencimento).slice(5, 7));
      const ano  = dar.ano_referencia || Number(String(dar.data_vencimento).slice(0, 4));
      const venc = String(dar.data_vencimento).slice(0, 10);

      const receitaCodigo = (tipo === 3) ? 20165 : 20164;
      const obsPrefix = dar.permissionario_id ? 'Aluguel CIPT' : 'Evento CIPT';
      const observacao = nome ? `${obsPrefix} - ${nome}` : obsPrefix;

      // 3) tentativa: payload único
      const payload = {
        contribuinteEmitente: { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio },
        receitas: [{
          codigo: receitaCodigo,
          competencia: { mes, ano },
          valorPrincipal: Number(dar.valor),
          valorDesconto: 0,
          dataVencimento: venc
        }],
        dataLimitePagamento: venc,
        observacao
      };

      // 4) fallback: (contribuinte, guiaLike)
      const contrib = { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio };
      const guiaLike = {
        id: dar.id,
        valor: Number(dar.valor),
        data_vencimento: venc,
        mes_referencia: mes,
        ano_referencia: ano,
        observacao,
        codigo_receita: receitaCodigo,
      };

      let sefaz;
      try {
        sefaz = await emitirGuiaSefaz(payload);
      } catch (e1) {
        if (/argument|param/i.test(String(e1?.message || ''))) {
          sefaz = await emitirGuiaSefaz(contrib, guiaLike);
        } else {
          throw e1;
        }
      }

      if (!sefaz || !sefaz.numeroGuia || !sefaz.pdfBase64) {
        return res.status(502).json({ error: 'Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).' });
      }

      // 5) persistência
      const tokenDoc = `DAR-${sefaz.numeroGuia}`;
      const pdfComToken = await imprimirTokenEmPdf(sefaz.pdfBase64, tokenDoc);

      await dbRunAsync(`
        UPDATE dars
           SET numero_documento = ?,
               pdf_url          = ?,
               status           = CASE WHEN COALESCE(status,'') IN ('','Pendente','Vencido','Vencida') THEN 'Emitido' ELSE status END,
               data_emissao     = COALESCE(data_emissao, date('now')),
               emitido_por_id   = COALESCE(emitido_por_id, ?)
         WHERE id = ?`,
        [sefaz.numeroGuia, pdfComToken, req.user?.id || null, darId]
      );

      const ld = sefaz.linhaDigitavel || sefaz.linha_digitavel || null;
      const cb = sefaz.codigoBarras  || sefaz.codigo_barras  || null;
      if (ld || cb) {
        await dbRunAsync(
          `UPDATE dars SET linha_digitavel = COALESCE(?, linha_digitavel),
                           codigo_barras  = COALESCE(?, codigo_barras)
           WHERE id = ?`,
          [ld, cb, darId]
        );
      }

      return res.json({ ok: true, numero: sefaz.numeroGuia });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /:id/emitir:', err);
      return res.status(400).json({ error: err.message || 'Falha ao emitir a DAR.' });
    }
  }
);

// POST /api/admin/dars/:id/reemitir
router.post(
  '/:id/reemitir',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = Number(req.params.id);
      const { codigoTipoInscricao, numeroInscricao, nome, codigoIbgeMunicipio, dar } =
        await getContribuinteEmitenteForDar(darId);

      const doc  = String(numeroInscricao || '').replace(/\D/g, '');
      if (doc.length !== 11 && doc.length !== 14) {
        return res.status(400).json({ error: 'Documento inválido (CPF 11 dígitos ou CNPJ 14).' });
      }
      const tipo = (doc.length === 11) ? 3 : 4;

      const mes  = dar.mes_referencia || Number(String(dar.data_vencimento).slice(5, 7));
      const ano  = dar.ano_referencia || Number(String(dar.data_vencimento).slice(0, 4));
      const venc = String(dar.data_vencimento).slice(0, 10);

      const receitaCodigo = (tipo === 3) ? 20165 : 20164;
      const obsPrefix = dar.permissionario_id ? 'Aluguel CIPT' : 'Evento CIPT';
      const observacao = nome ? `${obsPrefix} - ${nome}` : obsPrefix;

      const payload = {
        contribuinteEmitente: { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio },
        receitas: [{
          codigo: receitaCodigo,
          competencia: { mes, ano },
          valorPrincipal: Number(dar.valor),
          valorDesconto: 0,
          dataVencimento: venc
        }],
        dataLimitePagamento: venc,
        observacao
      };

      const contrib = { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio };
      const guiaLike = {
        id: dar.id,
        valor: Number(dar.valor),
        data_vencimento: venc,
        mes_referencia: mes,
        ano_referencia: ano,
        observacao,
        codigo_receita: receitaCodigo,
      };

      let sefaz;
      try {
        sefaz = await emitirGuiaSefaz(payload);
      } catch (e1) {
        if (/argument|param/i.test(String(e1?.message || ''))) {
          sefaz = await emitirGuiaSefaz(contrib, guiaLike);
        } else {
          throw e1;
        }
      }

      if (!sefaz || !sefaz.numeroGuia || !sefaz.pdfBase64) {
        return res.status(502).json({ error: 'Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).' });
      }

      const tokenDoc = `DAR-${sefaz.numeroGuia}`;
      const pdfComToken = await imprimirTokenEmPdf(sefaz.pdfBase64, tokenDoc);

      await dbRunAsync(`
        UPDATE dars
           SET numero_documento = ?,
               pdf_url          = ?,
               status           = CASE WHEN COALESCE(status,'') IN ('','Pendente','Vencido','Vencida') THEN 'Emitido' ELSE status END,
               data_emissao     = COALESCE(data_emissao, date('now')),
               emitido_por_id   = COALESCE(emitido_por_id, ?)
         WHERE id = ?`,
        [sefaz.numeroGuia, pdfComToken, req.user?.id || null, darId]
      );

      const ld = sefaz.linhaDigitavel || sefaz.linha_digitavel || null;
      const cb = sefaz.codigoBarras  || sefaz.codigo_barras  || null;
      if (ld || cb) {
        await dbRunAsync(
          `UPDATE dars SET linha_digitavel = COALESCE(?, linha_digitavel),
                           codigo_barras  = COALESCE(?, codigo_barras)
           WHERE id = ?`,
          [ld, cb, darId]
        );
      }

      return res.json({ ok: true, numero: sefaz.numeroGuia });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /:id/reemitir:', err);
      return res.status(400).json({ error: err.message || 'Falha ao reemitir a DAR.' });
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
