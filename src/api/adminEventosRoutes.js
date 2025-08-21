// src/api/adminEventosRoutes.js
const express = require('express');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { criarEventoComDars, atualizarEventoComDars } = require('../services/eventoDarService');

const {
  uploadDocumentFromFile,
  createSigner,
  requestSignatures,
  getDocument,
  pickBestArtifactUrl
} = require('../services/assinafyService');

// CORRIGIDO: Nome da função para corresponder ao que é exportado pelo serviço.
const { gerarTermoEventoPdfEIndexar } = require('../services/termoEventoPdfkitService');

const fs = require('fs');
const db = require('../database/db');

const router = express.Router();

/* ========= Helpers ========= */
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

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

/* ========= Middleware (apenas uma vez) ========= */
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

// POST /api/admin/eventos/:id/termo/enviar-assinatura
router.post('/:id/termo/enviar-assinatura', async (req, res) => {
  const { id } = req.params;
  const { signerName, signerEmail, signerCpf, signerPhone, message, expiresAt } = req.body || {};

  try {
    // 1) Gera/garante o termo e salva (usa seu service já ok)
    const out = await gerarTermoEventoPdfkitEIndexar(id); // { filePath, fileName }

    // 2) Upload pro Assinafy
    const uploaded = await uploadDocumentFromFile(out.filePath, out.fileName);
    const assinafyDocId = uploaded?.id || uploaded?.data?.id;
    if (!assinafyDocId) {
      return res.status(500).json({ ok: false, error: 'Falha no upload ao Assinafy.' });
    }

    // 3) Cria o signatário (se necessário)
    // Obs.: se você já mantém signerId, use direto. Aqui criamos sempre um simples.
    const signer = await createSigner({
      full_name: signerName,
      email: signerEmail,
      government_id: signerCpf,
      phone: signerPhone
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) {
      return res.status(500).json({ ok: false, error: 'Falha ao criar signatário no Assinafy.' });
    }

    // 4) Solicita assinatura (virtual)
    await requestSignatures(assinafyDocId, [signerId], {
      message,
      expires_at: expiresAt // opcional (ISO)
    });

    // 5) Atualiza metadados em `documentos`
    await dbRun(
      `UPDATE documentos
         SET assinafy_id = ?, status = 'pendente_assinatura'
       WHERE evento_id = ? AND tipo = 'termo_evento'`,
      [assinafyDocId, id],
      'termo/assinafy-up'
    );

    return res.json({
      ok: true,
      message: 'Documento enviado para assinatura (Assinafy).',
      assinafyDocId
    });
  } catch (err) {
    console.error('[assinafy] erro:', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Falha ao enviar para assinatura.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos
   Listar eventos
   =========================================================== */
router.get('/', async (_req, res) => {
  try {
    // CORRIGIDO: Adicionadas crases (`) ao redor da query SQL
    const sql = `
      SELECT e.id, e.nome_evento, e.espaco_utilizado, e.area_m2,
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
   Listar DARs do evento
   =========================================================== */
router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    // CORRIGIDO: Adicionadas crases (`) e separado o parâmetro da query
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
   Detalhes do evento
   =========================================================== */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // CORRIGIDO: Adicionadas crases (`) e separado o parâmetro da query
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

    // CORRIGIDO: Adicionadas crases (`) e separado o parâmetro da query
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

// GET /api/admin/eventos/:id/termo/assinafy-status
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
    // se já “certificated”, salvar a URL assinada e data
    if (doc?.status === 'certificated') {
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

/* Alias */
router.get('/:id/detalhes', async (req, res) => {
  // CORRIGIDO: Adicionadas crases (`)
  req.url = `/${req.params.id}`;
  return router.handle(req, res);
});

/* ===========================================================
   PUT /api/admin/eventos/:id
   Atualiza evento e reemite DARs
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
   Reemitir DAR específica
   =========================================================== */
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  // CORRIGIDO: Adicionadas crases (`)
  console.log(`[ADMIN] Reemitir DAR ID: ${darId} do Evento ID: ${eventoId}`);

  try {
    // CORRIGIDO: Adicionadas crases (`) e separado o parâmetro da query
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
      // CORRIGIDO: Adicionadas crases (`)
      observacao: `CIPT Evento: ${row.nome_evento} (Montagem ${row.hora_montagem || '-'}; Evento ${row.hora_inicio || '-'}-${row.hora_fim || '-'}; Desmontagem ${row.hora_desmontagem || '-'}) | Parcela ${row.numero_parcela}/${row.total_parcelas} (Reemissão)`
    };

    const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);
    const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
    retornoSefaz.pdfBase64 = await imprimirTokenEmPdf(retornoSefaz.pdfBase64, tokenDoc);

    // CORRIGIDO: Adicionadas crases (`)
    const updateSql = `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`;
    await dbRun(updateSql, [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId], 'reemitir/update-dars');

    // CORRIGIDO: Adicionadas crases (`)
    console.log(`[ADMIN] DAR ID: ${darId} reemitida. Novo número: ${retornoSefaz.numeroGuia}`);
    res.status(200).json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });
  } catch (err) {
    // CORRIGIDO: Adicionadas crases (`)
    console.error(`[ERRO] Ao reemitir DAR ID ${darId}:`, err.message);
    res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/:id/termo
   Gera o TERMO (PDFKit) + indexa + envia download
   =========================================================== */
router.get('/:id/termo', async (req, res) => {
  const { id } = req.params;

  // 🔎 mostre qual arquivo o Node resolveu para o service
  const resolved = require.resolve('../services/termoEventoPdfkitService');
  console.log('[TERMO][ROUTE] usando service em:', resolved);

  // 🔎 headers de diagnóstico (dá pra ver no DevTools/Network ou via curl)
  res.setHeader('X-Doc-Route', 'adminEventosRoutes/:id/termo');
  res.setHeader('X-Doc-Gen', 'pdfkit-v3');     // mude aqui sempre que atualizar
  res.setHeader('X-Doc-Resolved', resolved);

  try {
    const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');
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
   Retorna metadados do último termo gerado
   =========================================================== */
router.post('/:eventoId/termo/disponibilizar', async (req, res) => {
  try {
    const { eventoId } = req.params;
    // CORRIGIDO: Adicionadas crases (`)
    const sql = `SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`;
    const row = await dbGet(sql, [eventoId], 'termo/get-doc-row');
    if (!row) return res.status(404).json({ ok: false, error: 'Nenhum termo gerado ainda.' });
    return res.json({
      ok: true,
      documentoId: row.id,
      pdf_url: row.pdf_public_url,
      url_visualizacao: row.pdf_public_url
    });
  } catch (err) {
    console.error('[admin disponibilizar termo] erro:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao disponibilizar termo.' });
  }
});

/* ===========================================================
   DELETE /api/admin/eventos/:eventoId
   Apaga evento + DARs
   =========================================================== */
router.delete('/:eventoId', async (req, res) => {
  const { eventoId } = req.params;
  // CORRIGIDO: Adicionadas crases (`)
  console.log(`[ADMIN] Apagar evento ID: ${eventoId}`);

  try {
    await dbRun('BEGIN TRANSACTION', [], 'apagar/BEGIN');

    const darsRows = await dbAll('SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/listar-vinculos');
    const darIds = darsRows.map(r => r.id_dar);

    await dbRun('DELETE FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/delete-join');

    if (darIds.length) {
      const placeholders = darIds.map(() => '?').join(',');
      // CORRIGIDO: Adicionadas crases (`)
      const deleteSql = `DELETE FROM dars WHERE id IN (${placeholders})`;
      await dbRun(deleteSql, darIds, 'apagar/delete-dars');
    }

    const result = await dbRun('DELETE FROM Eventos WHERE id = ?', [eventoId], 'apagar/delete-evento');
    if (!result.changes) throw new Error('Nenhum evento encontrado com este ID.');

    await dbRun('COMMIT', [], 'apagar/COMMIT');

    // CORRIGIDO: Adicionadas crases (`)
    console.log(`[ADMIN] Evento ${eventoId} e ${darIds.length} DARs apagados.`);
    res.status(200).json({ message: 'Evento e DARs associadas apagados com sucesso!' });
  } catch (err) {
    try { await dbRun('ROLLBACK', [], 'apagar/ROLLBACK'); } catch {}
    // CORRIGIDO: Adicionadas crases (`)
    console.error(`[ERRO] Ao apagar evento ID ${eventoId}:`, err.message);
    res.status(500).json({ error: 'Falha ao apagar o evento.' });
  }
});

module.exports = router;
