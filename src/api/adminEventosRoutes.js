// src/api/adminEventosRoutes.js
const express = require('express');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { criarEventoComDars, atualizarEventoComDars } = require('../services/eventoDarService');

const {
  uploadDocumentFromFile,
  ensureSigner,
  requestSignatures,
  getDocument,
  // prepareDocument, // ← NÃO usamos no fluxo virtual sem campos
  pickBestArtifactUrl,
  waitForDocumentReady,
  getSigningUrl,
} = require('../services/assinafyService');

const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const { normalizeMsisdn } = require('../utils/phone');

const router = express.Router();

/* ========= Helpers ========= */
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ========= SQLite helpers com log ========= */
const dbGet = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][GET]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.get(sql, p, (err, row) => {
      if (err) {
        console.error('[SQL][GET][ERRO]', ctx, err.message);
        return reject(err);
      }
      resolve(row);
    });
  });

const dbAll = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][ALL]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.all(sql, p, (err, rows) => {
      if (err) {
        console.error('[SQL][ALL][ERRO]', ctx, err.message);
        return reject(err);
      }
      console.log('[SQL][ALL][OK]', ctx, 'rows:', rows?.length ?? 0);
      resolve(rows);
    });
  });

const dbRun = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][RUN]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.run(sql, p, function (err) {
      if (err) {
        console.error('[SQL][RUN][ERRO]', ctx, err.message);
        return reject(err);
      }
      console.log('[SQL][RUN][OK]', ctx, 'lastID:', this.lastID, 'changes:', this.changes);
      resolve(this);
    });
  });

/* ========= Middleware ========= */
router.use(adminAuthMiddleware);

/* ===========================================================
   POST /api/admin/eventos
   Criar evento + emitir DARs
   =========================================================== */
router.post('/', async (req, res) => {
  console.log('[DEBUG] /api/admin/eventos payload:', JSON.stringify(req.body, null, 2));
  try {
    const { eventoGratuito, justificativaGratuito, ...rest } = req.body || {};
    const eventoId = await criarEventoComDars(
      db,
      { ...rest, eventoGratuito, justificativaGratuito },
      { emitirGuiaSefaz, gerarTokenDocumento, imprimirTokenEmPdf }
    );
    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });
  } catch (err) {
    console.error('[ERRO] criar evento:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
  }
});

/* ===========================================================
   POST /api/admin/eventos/:id/termo/enviar-assinatura
   Gera o termo, faz upload na Assinafy, cria signer e assignment,
   salva assinatura_url para o front do cliente abrir o pop-up.
   =========================================================== */
router.post('/:id/termo/enviar-assinatura', async (req, res) => {
  const { id } = req.params;
  let { signerName, signerEmail, signerCpf, signerPhone, message, expiresAt } = req.body || {};

  try {
    // busca dados padrão do permissionário associado ao evento, se necessário
    if (!signerName || !signerEmail || !signerCpf || !signerPhone) {
      const sql = `
        SELECT c.nome_responsavel, c.nome_razao_social, c.email, c.telefone,
               c.documento_responsavel, c.documento
          FROM Eventos e
          JOIN Clientes_Eventos c ON c.id = e.id_cliente
         WHERE e.id = ?`;
      const row = await dbGet(sql, [id], 'termo/default-signer');
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Evento ou permissionário não encontrado.' });
      }
      signerName  = signerName  || row.nome_responsavel || row.nome_razao_social || 'Responsável';
      signerEmail = signerEmail || row.email;
      signerCpf   = signerCpf   || onlyDigits(row.documento_responsavel || row.documento || '');
      signerPhone = normalizeMsisdn(signerPhone || row.telefone || '');
    }

    if (!signerName || !signerEmail || !signerCpf || !signerPhone) {
      return res.status(400).json({ ok: false, error: 'Dados do signatário incompletos.' });
    }

    // 1) Gera/garante o termo
    const out = await gerarTermoEventoPdfkitEIndexar(id); // { filePath, fileName }

    // 2) Upload para a Assinafy
    const uploaded = await uploadDocumentFromFile(out.filePath, out.fileName);
    const assinafyDocId = uploaded?.id || uploaded?.data?.id;
    if (!assinafyDocId) {
      return res.status(500).json({ ok: false, error: 'Falha no upload ao Assinafy.' });
    }

    // 3) Aguarda processamento do documento (até metadata_ready)
    try {
      await waitForDocumentReady(assinafyDocId, { retries: 20, intervalMs: 3000 });
    } catch (err) {
      if (err.timeout) {
        return res.status(504).json({ ok: false, error: 'Tempo limite ao processar documento no Assinafy.' });
      }
      throw err;
    }

    // 4) Cria/garante o signatário
    const signer = await ensureSigner({
      full_name: signerName,
      email: signerEmail,
      government_id: onlyDigits(signerCpf),
      phone: `+55${normalizeMsisdn(signerPhone)}`
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) {
      return res.status(500).json({ ok: false, error: 'Falha ao criar signatário no Assinafy.' });
    }

    // 5) Cria assignment (virtual) — sem campos — e lida com "metadata_processing"
    const maxRetries = 3;
    let assigned = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await requestSignatures(assinafyDocId, [signerId], {
          message,
          expires_at: expiresAt // ISO opcional
        });
        assigned = true;
        break; // sucesso
      } catch (err) {
        const status = err.response?.status;
        const assinafyMsg = err.response?.data?.message;
        console.warn('[assinafy] requestSignatures erro:', status, assinafyMsg);

        if ((assinafyMsg === 'metadata_processing' || status === 400) && attempt < maxRetries - 1) {
          await sleep(2000);
          try {
            await waitForDocumentReady(assinafyDocId, { retries: 5, intervalMs: 3000 });
          } catch (waitErr) {
            if (waitErr.timeout) {
              return res.status(504).json({ ok: false, error: 'Tempo limite ao processar documento no Assinafy.' });
            }
          }
          continue;
        }
        if (status === 409 || /already.*assignment/i.test(String(assinafyMsg))) {
          assigned = true;
          break;
        }
        throw err;
      }
    }

    if (!assigned) {
      return res.status(500).json({ ok: false, error: 'Não foi possível criar o assignment no Assinafy.' });
    }

    // 6) Buscar URL de assinatura (com 3 tentativas, caso crie de forma assíncrona)
    let assinaturaUrl = null;
    for (let i = 0; i < 3; i++) {
      assinaturaUrl = await getSigningUrl(assinafyDocId);
      if (assinaturaUrl) break;
      await sleep(1200);
    }

    // 7) Atualiza metadados em `documentos`
    await dbRun(
      `UPDATE documentos
         SET assinafy_id = ?, status = 'pendente_assinatura', assinatura_url = ?
       WHERE evento_id = ? AND tipo = 'termo_evento'`,
      [assinafyDocId, assinaturaUrl || null, id],
      'termo/assinafy-up'
    );

    return res.json({
      ok: true,
      message: 'Documento enviado e aguardando assinatura (Assinafy).',
      assinafyDocId,
      assinaturaUrl
    });
  } catch (err) {
    console.error('[assinafy] erro:', err.message, err.response?.data);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Falha ao enviar para assinatura.',
      assinafyMessage: err.response?.data?.message
    });
  }
});

/* ===========================================================
   GET /api/admin/eventos
   =========================================================== */
router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT e.id, e.id_cliente, e.nome_evento, e.espaco_utilizado, e.area_m2,
             e.valor_final, e.status, e.data_vigencia_final,
             e.numero_oficio_sei, e.numero_processo, e.numero_termo,
             e.hora_inicio, e.hora_fim, e.hora_montagem, e.hora_desmontagem,
             c.nome_razao_social AS nome_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON e.id_cliente = c.id
       ORDER BY e.id DESC`;
    const rows = await dbAll(sql, [], 'listar-eventos');
    res.json(rows);
  } catch (err) {
    console.error('[admin/eventos] listar erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor ao buscar eventos.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/:eventoId/dars
   =========================================================== */
router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const sql = `
      SELECT
         de.numero_parcela,
         de.valor_parcela,
         d.id AS dar_id,
         d.data_vencimento AS dar_venc,
         d.status AS dar_status,
         d.pdf_url AS dar_pdf
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`;
    const rows = await dbAll(sql, [eventoId], 'listar-dars-por-evento');
    res.json({ dars: rows });
  } catch (err) {
    console.error('[admin/eventos] listar DARs erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/:id
   =========================================================== */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const evSql = `
      SELECT e.*, c.nome_razao_social AS nome_cliente, c.tipo_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON c.id = e.id_cliente
       WHERE e.id = ?`;
    const ev = await dbGet(evSql, [id], 'evento/get-by-id');

    if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });

    let datas = [];
    try {
      if (typeof ev.datas_evento === 'string') {
        datas = ev.datas_evento.trim().startsWith('[')
          ? JSON.parse(ev.datas_evento)
          : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(ev.datas_evento)) {
        datas = ev.datas_evento;
      }
    } catch { /* noop */ }

    const parcelasSql = `
        SELECT
            de.numero_parcela,
            de.valor_parcela            AS valor,
            de.data_vencimento          AS vencimento,
            d.id                        AS dar_id,
            d.status                    AS dar_status,
            d.pdf_url                   AS dar_pdf,
            d.numero_documento          AS dar_numero
           FROM DARs_Eventos de
           JOIN dars d ON d.id = de.id_dar
          WHERE de.id_evento = ?
          ORDER BY de.numero_parcela ASC`;
    const parcelas = await dbAll(parcelasSql, [id], 'evento/get-parcelas');

    const payload = {
      evento: {
        id: ev.id,
        id_cliente: ev.id_cliente,
        nome_evento: ev.nome_evento,
        espaco_utilizado: ev.espaco_utilizado,
        area_m2: ev.area_m2,
        datas_evento: datas,
        total_diarias: ev.total_diarias,
        valor_bruto: ev.valor_bruto,
        tipo_desconto_auto: ev.tipo_desconto,
        desconto_manual_percent: ev.desconto_manual,
        valor_final: ev.valor_final,
        numero_processo: ev.numero_processo,
        numero_termo: ev.numero_termo,
        evento_gratuito: ev.evento_gratuito,
        justificativa_gratuito: ev.justificativa_gratuito,
        status: ev.status,
        nome_cliente: ev.nome_cliente,
        tipo_client_
