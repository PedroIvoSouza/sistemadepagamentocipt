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
  pickBestArtifactUrl,
  waitForDocumentReady,
  getSigningUrl,
  onlyDigits,
} = require('../services/assinafyService');

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const { normalizeMsisdn } = require('../utils/phone');

// Nome corrigido p/ corresponder ao service real
const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');

const router = express.Router();

/* ========= Helpers ========= */
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
   Fluxo completo: gera termo → upload → aguarda → ensureSigner → assignment → salva assinatura_url
   =========================================================== */
router.post('/:id/termo/enviar-assinatura', async (req, res) => {
  const { id } = req.params;
  let { signerName, signerEmail, signerCpf, signerPhone, message, expiresAt } = req.body || {};

  try {
    // 0) Dados do signatário, se não vieram no body, preenche do banco
    if (!signerName || !signerEmail || !signerCpf || !signerPhone) {
      const sql = `
        SELECT c.nome_responsavel, c.nome_razao_social, c.email, c.telefone,
               c.documento_responsavel, c.documento
          FROM Eventos e
          JOIN Clientes_Eventos c ON c.id = e.id_cliente
         WHERE e.id = ?`;
      const row = await dbGet(sql, [id], 'termo/default-signer');
      if (!row) return res.status(404).json({ ok: false, error: 'Evento ou permissionário não encontrado.' });

      signerName  = signerName  || row.nome_responsavel || row.nome_razao_social || 'Responsável';
      signerEmail = signerEmail || row.email;
      signerCpf   = signerCpf   || onlyDigits(row.documento_responsavel || row.documento || '');
      signerPhone = signerPhone || row.telefone || '';
    }

    if (!signerName || !signerEmail) {
      return res.status(400).json({ ok: false, error: 'Nome e email do signatário são obrigatórios.' });
    }

    // 1) Gera/garante o termo e salva
    const out = await gerarTermoEventoPdfkitEIndexar(id); // { filePath, fileName }

    // 2) Upload pro Assinafy
    const uploaded = await uploadDocumentFromFile(out.filePath, out.fileName);
    const assinafyDocId = uploaded?.id || uploaded?.data?.id;
    if (!assinafyDocId) return res.status(500).json({ ok: false, error: 'Falha no upload ao Assinafy.' });

    // 3) Aguarda o processamento (até ficar apto a receber assignment)
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
      government_id: onlyDigits(signerCpf || ''),
      phone: `+55${onlyDigits(signerPhone || '')}`,
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) return res.status(500).json({ ok: false, error: 'Falha ao criar signatário no Assinafy.' });

    // 5) Assignment (virtual) — com retry leve para "metadata_processing"
    const maxRetries = 3;
    let assigned = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await requestSignatures(assinafyDocId, [signerId], { message, expires_at: expiresAt });
        assigned = true;
        break;
      } catch (err) {
        const status = err.response?.status;
        const assinafyMsg = err.response?.data?.message;
        if ((assinafyMsg === 'metadata_processing' || status === 400) && attempt < maxRetries - 1) {
          await sleep(2000);
          await waitForDocumentReady(assinafyDocId, { retries: 5, intervalMs: 1500 });
          continue;
        }
        if (status === 409) { assigned = true; break; } // já existe assignment
        throw err;
      }
    }
    if (!assigned) return res.status(500).json({ ok: false, error: 'Não foi possível criar o assignment.' });

    // 6) Busca a URL de assinatura
    let assinaturaUrl = null;
    for (let i = 0; i < 3; i++) {
      assinaturaUrl = await getSigningUrl(assinafyDocId);
      if (assinaturaUrl) break;
      await sleep(1000);
    }

    // 7) Atualiza metadados
    await dbRun(
      `UPDATE documentos
          SET assinafy_id = ?, status = 'pendente_assinatura', assinatura_url = ?
        WHERE evento_id = ? AND tipo = 'termo_evento'`,
      [assinafyDocId, assinaturaUrl || null, id],
      'termo/assinafy-up'
    );

    return res.json({
      ok: true,
      message: 'Documento enviado para assinatura (Assinafy).',
      assinafyDocId,
      assinaturaUrl,
    });
  } catch (err) {
    console.error('[assinafy] erro:', err.message, err.response?.data);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Falha ao enviar para assinatura.',
      assinafyMessage: err.response?.data?.message,
    });
  }
});

/* ===========================================================
   NOVO: Reativar assinatura em documento já enviado
   POST /api/admin/eventos/:id/termo/reativar-assinatura
   - usa o assinafy_id salvo, garante signer e (re)cria assignment
   - popula assinatura_url se faltava
   =========================================================== */
router.post('/:id/termo/reativar-assinatura', async (req, res) => {
  const { id } = req.params;
  let { signerName, signerEmail, signerCpf, signerPhone, message, expiresAt } = req.body || {};

  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id],
      'reativar/get-doc'
    );
    if (!row?.assinafy_id) {
      return res.status(404).json({ ok: false, error: 'Este evento ainda não possui documento enviado à Assinafy.' });
    }
    const assinafyDocId = row.assinafy_id;

    // dados do signer
    if (!signerName || !signerEmail || !signerCpf || !signerPhone) {
      const sql = `
        SELECT c.nome_responsavel, c.nome_razao_social, c.email, c.telefone,
               c.documento_responsavel, c.documento
          FROM Eventos e
          JOIN Clientes_Eventos c ON c.id = e.id_cliente
         WHERE e.id = ?`;
      const p = await dbGet(sql, [id], 'reativar/default-signer');
      if (!p) return res.status(404).json({ ok: false, error: 'Evento/permissionário não encontrado.' });

      signerName  = signerName  || p.nome_responsavel || p.nome_razao_social || 'Responsável';
      signerEmail = signerEmail || p.email;
      signerCpf   = signerCpf   || onlyDigits(p.documento_responsavel || p.documento || '');
      signerPhone = signerPhone || p.telefone || '';
    }
    if (!signerEmail) return res.status(400).json({ ok: false, error: 'Email do signatário não encontrado.' });

    // garantir que o doc está pronto
    await waitForDocumentReady(assinafyDocId, { retries: 10, intervalMs: 2000 });

    // ensure signer
    const signer = await ensureSigner({
      full_name: signerName,
      email: signerEmail,
      government_id: onlyDigits(signerCpf || ''),
      phone: `+55${onlyDigits(signerPhone || '')}`,
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) return res.status(500).json({ ok: false, error: 'Falha ao criar signatário.' });

    // (re)cria assignment
    try {
      await requestSignatures(assinafyDocId, [signerId], { message, expires_at: expiresAt });
    } catch (err) {
      if (err.response?.status !== 409) throw err; // 409 = já existe
    }

    // recupera assinatura_url
    let assinaturaUrl = await getSigningUrl(assinafyDocId);
    if (!assinaturaUrl) {
      await sleep(1000);
      assinaturaUrl = await getSigningUrl(assinafyDocId);
    }

    await dbRun(
      `UPDATE documentos
          SET status = 'pendente_assinatura', assinatura_url = COALESCE(?, assinatura_url)
        WHERE evento_id = ? AND tipo = 'termo_evento'`,
      [assinaturaUrl || null, id],
      'reativar/update-doc'
    );

    return res.json({ ok: true, assinafyDocId, assinaturaUrl });
  } catch (err) {
    console.error('[reativar-assinatura] erro:', err.message, err.response?.data);
    return res.status(500).json({ ok: false, error: 'Falha ao reativar assinatura.' });
  }
});

/* ===========================================================
   NOVO: Consultar/forçar recuperação da assinatura_url
   GET /api/admin/eventos/:id/termo/assinatura-url
   =========================================================== */
router.get('/:id/termo/assinatura-url', async (req, res) => {
  const { id } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id],
      'assinatura-url/get'
    );
    if (!row?.assinafy_id) {
      return res.status(404).json({ ok: false, error: 'Sem assinafy_id salvo para este termo.' });
    }

    let assinaturaUrl = row.assinatura_url;
    if (!assinaturaUrl) {
      assinaturaUrl = await getSigningUrl(row.assinafy_id);
      if (assinaturaUrl) {
        await dbRun(
          `UPDATE documentos SET assinatura_url = ? WHERE evento_id = ? AND tipo = 'termo_evento'`,
          [assinaturaUrl, id],
          'assinatura-url/update'
        );
      }
    }

    return res.json({ ok: true, assinaturaUrl });
  } catch (err) {
    console.error('[assinatura-url] erro:', err.message);
    return res.status(500).json({ ok: false, error: 'Falha ao obter assinatura_url.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos
   Listar eventos
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
        tipo_cliente: ev.tipo_cliente,
        hora_inicio: ev.hora_inicio,
        hora_fim: ev.hora_fim,
        hora_montagem: ev.hora_montagem,
        hora_desmontagem: ev.hora_desmontagem
      },
      parcelas
    };

    return res.json(payload);
  } catch (err) {
    console.error(`[admin/eventos/:id] erro:`, err.message);
    return res.status(500).json({ error: 'Erro interno ao buscar o evento.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/:id/termo/assinafy-status
   =========================================================== */
router.get('/:id/termo/assinafy-status', async (req, res) => {
  const { id } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id],
      'termo/assinafy-get'
    );
    if (!row?.assinafy_id) return res.status(404).json({ ok: false, error: 'Sem assinafy_id para este termo.' });

    const doc = await getDocument(row.assinafy_id);
    // se já “certified”, salvar dados
    if (['certified', 'certificated', 'assinado'].includes(String(doc?.status))) {
      const bestUrl = pickBestArtifactUrl(doc);
      await dbRun(
        `UPDATE documentos
             SET status = 'assinado',
                 signed_pdf_public_url = COALESCE(signed_pdf_public_url, ?),
                 signed_at = COALESCE(signed_at, datetime('now'))
           WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [bestUrl || null, id],
        'termo/assinafy-cert'
      );
    }
    return res.json({ ok: true, assinafy: doc });
  } catch (err) {
    console.error('[assinafy-status] erro:', err.message);
    return res.status(500).json({ ok: false, error: 'Falha ao consultar status no Assinafy.' });
  }
});

/* Alias para /:id */
router.get('/:id/detalhes', async (req, res) => {
  req.url = `/${req.params.id}`;
  return router.handle(req, res);
});

/* ===========================================================
   PUT /api/admin/eventos/:id
   =========================================================== */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { eventoGratuito, justificativaGratuito, ...rest } = req.body || {};
    await atualizarEventoComDars(
      db,
      id,
      { ...rest, eventoGratuito, justificativaGratuito },
      { emitirGuiaSefaz, gerarTokenDocumento, imprimirTokenEmPdf }
    );

    return res.json({ message: 'Evento atualizado e DARs reemitidas com sucesso.', id: Number(id) });
  } catch (err) {
    console.error(`[admin/eventos PUT/:id] erro:`, err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Erro ao atualizar o evento.' });
  }
});

/* ===========================================================
   POST /api/admin/eventos/:eventoId/dars/:darId/reemitir
   =========================================================== */
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  console.log(`[ADMIN] Reemitir DAR ID: ${darId} do Evento ID: ${eventoId}`);

  try {
    const sql = `
        SELECT e.nome_evento,
               e.hora_inicio, e.hora_fim, e.hora_montagem, e.hora_desmontagem,
               de.numero_parcela,
               (SELECT COUNT(*) FROM DARs_Eventos WHERE id_evento = e.id) AS total_parcelas,
               d.valor, d.data_vencimento,
               c.nome_razao_social, c.documento, c.endereco, c.cep
          FROM dars d
          JOIN DARs_Eventos de ON d.id = de.id_dar
          JOIN Eventos e       ON de.id_evento = e.id
          JOIN Clientes_Eventos c ON e.id_cliente = c.id
         WHERE d.id = ? AND e.id = ?`;
    const row = await dbGet(sql, [darId, eventoId], 'reemitir/buscar-contexto');

    if (!row) return res.status(404).json({ error: 'DAR ou Evento não encontrado.' });

    const documentoLimpo = onlyDigits(row.documento);
    const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
    const [ano, mes] = row.data_vencimento.split('-');

    const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO || '').replace(/\D/g, ''));
    if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');

    const payloadSefaz = {
      versao: '1.0',
      contribuinteEmitente: {
        codigoTipoInscricao: tipoInscricao,
        numeroInscricao: documentoLimpo,
        nome: row.nome_razao_social,
        codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
        descricaoEndereco: row.endereco,
        numeroCep: onlyDigits(row.cep)
      },
      receitas: [{
        codigo: receitaCod,
        competencia: { mes: Number(mes), ano: Number(ano) },
        valorPrincipal: row.valor,
        valorDesconto: 0.00,
        dataVencimento: row.data_vencimento
      }],
      dataLimitePagamento: row.data_vencimento,
      observacao: `CIPT Evento: ${row.nome_evento} (Montagem ${row.hora_montagem || '-'}; Evento ${row.hora_inicio || '-'}-${row.hora_fim || '-'}; Desmontagem ${row.hora_desmontagem || '-'}) | Parcela ${row.numero_parcela}/${row.total_parcelas} (Reemissão)`
    };

    const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);
    const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
    retornoSefaz.pdfBase64 = await imprimirTokenEmPdf(retornoSefaz.pdfBase64, tokenDoc);

    const updateSql = `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`;
    await dbRun(updateSql, [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId], 'reemitir/update-dars');

    console.log(`[ADMIN] DAR ID: ${darId} reemitida. Novo número: ${retornoSefaz.numeroGuia}`);
    res.status(200).json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });
  } catch (err) {
    console.error(`[ERRO] Ao reemitir DAR ID ${darId}:`, err.message);
    res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/:id/termo
   (gera e envia o PDF do termo)
   =========================================================== */
router.get('/:id/termo', async (req, res) => {
  const { id } = req.params;

  const resolved = require.resolve('../services/termoEventoPdfkitService');
  console.log('[TERMO][ROUTE] usando service em:', resolved);

  res.setHeader('X-Doc-Route', 'adminEventosRoutes/:id/termo');
  res.setHeader('X-Doc-Gen', 'pdfkit-v3');
  res.setHeader('X-Doc-Resolved', resolved);

  try {
    const docAssinado = await dbGet(
      `SELECT signed_pdf_public_url FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id],
      'termo/check-signed'
    );
    if (docAssinado?.signed_pdf_public_url) {
      const filePath = path.join(process.cwd(), 'public', docAssinado.signed_pdf_public_url.replace(/^\/+/, ''));
      if (fs.existsSync(filePath)) return res.sendFile(filePath);
    }

    const out = await gerarTermoEventoPdfkitEIndexar(id);
    const stat = fs.statSync(out.filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');

    fs.createReadStream(out.filePath).pipe(res);
  } catch (err) {
    console.error('[admin/eventos] termo erro:', err);
    res.status(500).json({ error: 'Falha ao gerar termo' });
  }
});

/* ===========================================================
   POST /api/admin/eventos/:eventoId/termo/disponibilizar
   =========================================================== */
router.post('/:eventoId/termo/disponibilizar', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const sql = `SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`;
    const row = await dbGet(sql, [eventoId], 'termo/get-doc-row');
    if (!row) return res.status(404).json({ ok: false, error: 'Nenhum termo gerado ainda.' });
    return res.json({
      ok: true,
      documentoId: row.id,
      pdf_url: row.pdf_public_url,
      url_visualizacao: row.pdf_public_url,
      assinatura_url: row.assinatura_url || null,
      assinafy_id: row.assinafy_id || null,
      status: row.status || null,
    });
  } catch (err) {
    console.error('[admin disponibilizar termo] erro:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao disponibilizar termo.' });
  }
});

/* ===========================================================
   DELETE /api/admin/eventos/:eventoId
   =========================================================== */
router.delete('/:eventoId', async (req, res) => {
  const { eventoId } = req.params;
  console.log(`[ADMIN] Apagar evento ID: ${eventoId}`);

  try {
    await dbRun('BEGIN TRANSACTION', [], 'apagar/BEGIN');

    const darsRows = await dbAll('SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/listar-vinculos');
    const darIds = darsRows.map(r => r.id_dar);

    await dbRun('DELETE FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/delete-join');

    if (darIds.length) {
      const placeholders = darIds.map(() => '?').join(',');
      const deleteSql = `DELETE FROM dars WHERE id IN (${placeholders})`;
      await dbRun(deleteSql, darIds, 'apagar/delete-dars');
    }

    const result = await dbRun('DELETE FROM Eventos WHERE id = ?', [eventoId], 'apagar/delete-evento');
    if (!result.changes) throw new Error('Nenhum evento encontrado com este ID.');

    await dbRun('COMMIT', [], 'apagar/COMMIT');

    console.log(`[ADMIN] Evento ${eventoId} e ${darIds.length} DARs apagados.`);
    res.status(200).json({ message: 'Evento e DARs associadas apagados com sucesso!' });
  } catch (err) {
    try { await dbRun('ROLLBACK', [], 'apagar/ROLLBACK'); } catch {}
    console.error(`[ERRO] Ao apagar evento ID ${eventoId}:`, err.message);
    res.status(500).json({ error: 'Falha ao apagar o evento.' });
  }
});

module.exports = router;
