// src/api/adminEventosRoutes.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const db = require('../database/db');

const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { criarEventoComDars, atualizarEventoComDars } = require('../services/eventoDarService');

const {
  uploadDocumentFromFile,
  ensureSigner,
  requestSignatures,
  getDocument,
  pickBestArtifactUrl,
  waitUntilPendingSignature,
  waitUntilReadyForAssignment,
  getSigningUrl,
  onlyDigits,
} = require('../services/assinafyService');

const { sendMessage } = require('../services/whatsappService');

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
   PUT /api/admin/eventos/:id
   Atualiza evento + reemitir DARs
   =========================================================== */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await atualizarEventoComDars(
      db,
      id,
      req.body,
      { emitirGuiaSefaz, gerarTokenDocumento, imprimirTokenEmPdf }
    );
    res.json({ message: 'Evento atualizado com sucesso!' });
  } catch (err) {
    console.error('[ERRO] atualizar evento:', err.message);
    let status = 500;
    if (err.status) status = err.status;
    else if (err.message) status = 400;
    res.status(status).json({ error: err.message || 'Não foi possível atualizar o evento.' });
  }
});

/* ===========================================================
   PATCH /api/admin/eventos/:id/status
   Atualiza o status do evento
   =========================================================== */
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const allowed = ['Pendente', 'Emitido', 'Reemitido', 'Parcialmente Pago', 'Pago', 'Realizado', 'Cancelado'];
  try {
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    const result = await dbRun(`UPDATE Eventos SET status = ? WHERE id = ?`, [status, id], 'patch-status-evento');
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Evento não encontrado.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERRO] atualizar status do evento:', err.message);
    res.status(500).json({ error: 'Não foi possível atualizar o status.' });
  }
});

/* ===========================================================
   POST /api/admin/eventos/:id/termo/enviar-assinatura
   Gera termo → upload → aguarda → ensureSigner → assignment → salva assinatura_url (se houver)
   =========================================================== */
router.post('/:id/termo/enviar-assinatura', async (req, res) => {
  const { id } = req.params;
  let { signerName, signerEmail, signerCpf, signerPhone, message, expiresAt } = req.body || {};

  try {
    // Etapa 0: Obter dados do signatário
    const sql = `
      SELECT c.nome_responsavel, c.nome_razao_social, c.email, c.telefone,
             c.documento_responsavel, c.documento,
             e.nome_evento, e.numero_termo
        FROM Eventos e
        JOIN Clientes_Eventos c ON c.id = e.id_cliente
       WHERE e.id = ?`;
    const row = await dbGet(sql, [id], 'termo/default-signer');
    if (!row) return res.status(404).json({ ok: false, error: 'Evento ou permissionário não encontrado.' });

    signerName  = signerName  || row.nome_responsavel || row.nome_razao_social || 'Responsável';
    signerEmail = signerEmail || row.email;
    if (!signerEmail) {
      return res.status(400).json({ ok:false, error:'E-mail do signatário é obrigatório.' });
    }
    signerCpf   = signerCpf   || onlyDigits(row.documento_responsavel || row.documento || '');
    signerPhone = signerPhone || row.telefone || '';

    // Etapa 1: Gerar o termo em PDF
    const out = await gerarTermoEventoPdfkitEIndexar(id);

    // Etapa 2: Fazer o upload para a Assinafy
    const uploaded = await uploadDocumentFromFile(out.filePath, out.fileName);
    const assinafyDocId = uploaded?.id || uploaded?.data?.id;
    if (!assinafyDocId) return res.status(500).json({ ok: false, error: 'Falha no upload ao Assinafy.' });

    // Etapa 3: Aguardar o documento ficar pronto
    await waitUntilReadyForAssignment(assinafyDocId, { retries: 20, intervalMs: 3000 });

    // Etapa 4: Garantir que o signatário existe na Assinafy
    const signer = await ensureSigner({
      full_name: signerName,
      email: signerEmail,
      government_id: onlyDigits(signerCpf || ''),
      phone: `+55${onlyDigits(signerPhone || '')}`,
    });
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) return res.status(500).json({ ok: false, error: 'Falha ao criar signatário no Assinafy.' });

    // Etapa 5: Solicitar a assinatura (Assignment). É isso que dispara o e-mail.
    await requestSignatures(assinafyDocId, [signerId], { message, expires_at: expiresAt });

    // Etapa 5b: Notificar via WhatsApp (não bloqueia o fluxo se falhar)
    if (signerPhone) {
      try {
        const digitsPhone = onlyDigits(signerPhone);
        const msisdn = digitsPhone.startsWith('55') ? digitsPhone : `55${digitsPhone}`;
        const texto = `Olá ${signerName},\n\n` +
          `O Termo de Permissão de Uso ${row.numero_termo} para o evento ${row.nome_evento} ` +
          `foi enviado para o e-mail ${signerEmail}. Assine o quanto antes para garantir a ` +
          `realização do seu evento no Centro de Inovação do Jaraguá.\n\nEquipe do CIPT.`;
        await sendMessage(msisdn, texto);
      } catch (e) {
        console.error('[WHATSAPP] falha ao notificar signatário:', e.message || e);
      }
    } else {
      console.log('[WHATSAPP] telefone do signatário ausente; notificação não enviada.');
    }

    // Etapa 6: Salvar no banco de dados. Note que 'assinaturaUrl' é explicitamente nulo.
    await dbRun(
      `INSERT INTO documentos (tipo, evento_id, pdf_url, pdf_public_url, status, created_at, assinafy_id, assinatura_url)
       VALUES ('termo_evento', ?, ?, ?, 'pendente_assinatura', datetime('now'), ?, NULL)
       ON CONFLICT(evento_id, tipo) DO UPDATE SET
         status = 'pendente_assinatura',
         assinafy_id = excluded.assinafy_id,
         assinatura_url = NULL`,
      [id, out.filePath, out.publicUrl || out.pdf_public_url || null, assinafyDocId]
    );

    // Etapa 7: Retornar sucesso para o Admin.
    return res.json({
      ok: true,
      message: 'Documento enviado com sucesso! O signatário receberá as instruções por e-mail.',
    });

  } catch (err) {
    console.error('[assinafy] erro no fluxo de enviar-assinatura:', err.message, err.response?.data);
    return res.status(500).json({
      ok: false,
      error: 'Falha no envio',
      assinafyMessage: err.response?.data?.message,
    });
  }
});

/* ===========================================================
   POST /api/admin/eventos/:id/termo/reativar-assinatura
   Recria assignment para o e-mail atual (ou fornecido no body)
   VERSÃO CORRIGIDA
   =========================================================== */
router.post('/:id/termo/reativar-assinatura', async (req, res) => {
  const { id } = req.params;
  let { signerName, signerEmail, signerCpf, signerPhone, message, expiresAt } = req.body || {};

  try {
    const row = await dbGet(
      `SELECT assinafy_id FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id],
      'reativar/get-doc'
    );
    if (!row?.assinafy_id) {
      return res.status(404).json({ ok: false, error: 'Este evento ainda não possui documento enviado à Assinafy.' });
    }
    const assinafyDocId = row.assinafy_id;

    // Obtenção dos dados do signatário (lógica mantida)
    if (!signerName || !signerEmail || !signerCpf || !signerPhone) {
      const p = await dbGet(
        `SELECT c.nome_responsavel, c.nome_razao_social, c.email, c.telefone, c.documento_responsavel, c.documento
           FROM Eventos e
           JOIN Clientes_Eventos c ON c.id = e.id_cliente
          WHERE e.id = ?`,
        [id],
        'reativar/default-signer'
      );
      if (!p) return res.status(404).json({ ok: false, error: 'Evento/permissionário não encontrado.' });

      signerName  = signerName  || p.nome_responsavel || p.nome_razao_social || 'Responsável';
      signerEmail = signerEmail || p.email;
      if (!signerEmail) {
        return res.status(400).json({ ok:false, error:'E-mail do signatário é obrigatório.' });
      }
      signerCpf   = signerCpf   || onlyDigits(p.documento_responsavel || p.documento || '');
      signerPhone = signerPhone || p.telefone || '';
    }
    
    // Garante que o signatário existe na Assinafy (lógica mantida)
    const signer = await ensureSigner({
      full_name: signerName,
      email: signerEmail,
      government_id: onlyDigits(signerCpf || ''),
      phone: `+55${onlyDigits(signerPhone || '')}`,
    });
    console.log('Using signer for reactivation', signer.email);
    const signerId = signer?.id || signer?.data?.id;
    if (!signerId) return res.status(500).json({ ok: false, error: 'Falha ao criar signatário.' });

    // Tenta (re)criar o assignment. A API da Assinafy se encarrega de reenviar o e-mail.
    try {
      await requestSignatures(assinafyDocId, [signerId], { message, expires_at: expiresAt });
    } catch (err) {
      // Ignoramos o erro 409 (conflito), que significa que um assignment já existe.
      // A Assinafy pode não recriar, mas o importante é garantir que o processo está ativo.
      if (err.response?.status !== 409) throw err;
    }

    // REMOVEMOS A BUSCA PELA URL. Não precisamos mais dela.

    // Apenas atualizamos o status no nosso banco, garantindo que a URL antiga (se houver) seja limpa.
    await dbRun(
      `UPDATE documentos
          SET status = 'pendente_assinatura',
              assinatura_url = NULL
        WHERE evento_id = ? AND tipo = 'termo_evento'`,
      [id],
      'reativar/update-doc'
    );
    
    // Retornamos sucesso para o Admin.
    return res.json({ ok: true, message: 'Solicitação de assinatura reenviada com sucesso.' });

  } catch (err) {
    console.error('[reativar-assinatura] erro:', err.message, err.response?.data);
    return res.status(500).json({ ok: false, error: 'Falha ao reativar assinatura.' });
  }
});

/* ===========================================================
   POST /api/admin/eventos/:id/termo/assinafy/link
   Força a obtenção do link (lê do documento e grava assinatura_url)
   =========================================================== */
router.post('/:id/termo/assinafy/link', async (req, res) => {
  const { id } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url FROM documentos
        WHERE evento_id = ? AND tipo = 'termo_evento'
     ORDER BY id DESC LIMIT 1`,
      [id],
      'admin/link/get-doc'
    );
    if (!row?.assinafy_id) return res.status(404).json({ ok:false, error:'Sem assinafy_id salvo para este termo.' });

    // Se já temos, devolve
    if (row.assinatura_url) {
      return res.json({ ok:true, url: row.assinatura_url });
    }

    await waitUntilPendingSignature(row.assinafy_id, { retries: 8, intervalMs: 1500 }).catch(()=>{});

    const assinaturaUrl = await getSigningUrl(row.assinafy_id);
    if (assinaturaUrl) {
      await dbRun(
        `UPDATE documentos SET assinatura_url = ?, status = 'pendente_assinatura'
          WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [assinaturaUrl, id],
        'admin/link/update'
      );
      return res.json({ ok:true, url: assinaturaUrl });
    }

    return res.json({ ok:true, pending:true, message:'Link ainda não disponível.' });
  } catch (e) {
    console.error('[admin/link] erro:', e.message);
    res.status(500).json({ ok:false, error:'Falha ao obter link.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/:id/termo/assinafy-status
   VERSÃO CORRIGIDA: Não salva mais a URL pública insegura
   =========================================================== */
router.get('/:id/termo/assinafy-status', async (req, res) => {
  const { id } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id]
    );
    if (!row?.assinafy_id) {
      // Se não foi enviado, retorna um status local claro
      return res.json({ ok: true, assinafy: { status: 'nao_enviado' } });
    }

    // Busca o status mais recente na Assinafy
    const doc = await getDocument(row.assinafy_id);
    const info = doc?.data || doc;
    const statusReal = info?.status;

    // Se o documento foi assinado/certificado, atualizamos nosso status no banco.
    // Note que NÃO salvamos mais a URL da Assinafy aqui.
    if (statusReal === 'certified' || statusReal === 'certificated') {
      await dbRun(
        `UPDATE documentos
           SET status = 'assinado',
               signed_at = COALESCE(signed_at, datetime('now'))
         WHERE evento_id = ? AND tipo = 'termo_evento' AND status != 'assinado'`,
        [id]
      );
    }

    return res.json({ 
      ok: true, 
      assinafy: info // Retorna o status real para o admin
    });
  } catch (err) {
    console.error(`[assinafy-status] erro para evento ${id}:`, err.message);
    return res.status(500).json({ ok: false, error: 'Falha ao consultar status no Assinafy.' });
  }
});


/* ===========================================================
   Rotas utilitárias já existentes (listar, detalhes, termo, etc.)
   =========================================================== */

// Funções de cálculo de valor
const precosPorDia = [2495.00, 1996.00, 1596.80, 1277.44, 1277.44];
function calcularValorBruto(n) {
  if (n <= 0) return 0;
  let v = 0;
  if (n >= 1) v += precosPorDia[0];
  if (n >= 2) v += precosPorDia[1];
  if (n >= 3) v += precosPorDia[2];
  if (n >= 4) v += (n - 3) * precosPorDia[3];
  return +v.toFixed(2);
}
function calcularValorFinal(vb, tipo, dm = 0) {
  let v = vb;
  if (tipo === 'Governo') v *= 0.8;
  else if (tipo === 'Permissionario') v *= 0.4;
  if (dm > 0) v *= (1 - dm / 100);
  return +v.toFixed(2);
}

/* ===========================================================
   GET /api/admin/eventos (Rota Principal de Listagem - VERSÃO FINAL)
   =========================================================== */
router.get('/', async (req, res) => {
  try {
    // Antes de qualquer consulta, atualizamos o status dos eventos com
    // data de vigência final já expirada para "Realizado".
    await dbRun(
      `UPDATE Eventos
          SET status = 'Realizado'
        WHERE DATE(substr(data_vigencia_final,1,10)) < DATE('now')
          AND status IN ('Pendente','Emitido','Reemitido','Pago','Parcialmente Pago')`,
      [],
      'realizar-eventos-passados'
    );

    const {
      search = '',
      page = 1,
      limit = 10,
      sort = 'data_vigencia_final', // Padrão: ordenar por data
      order = 'asc',                 // Padrão: do mais antigo para o mais novo
      filter = 'todos'
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const offset = (pageNum - 1) * limitNum;

    let whereClause = '';
    const params = [];
    if (search) {
      const like = `%${search}%`;
      whereClause += 'WHERE (e.nome_evento LIKE ? OR c.nome_razao_social LIKE ? OR e.numero_processo LIKE ?)';
      params.push(like, like, like);
    }

    if (filter === 'pago') {
      whereClause += whereClause ? ' AND ' : 'WHERE ';
      whereClause += 'e.evento_gratuito = 0';
    } else if (filter === 'gratuito') {
      whereClause += whereClause ? ' AND ' : 'WHERE ';
      whereClause += 'e.evento_gratuito = 1';
    }

    const colunasPermitidas = ['id', 'nome_evento', 'data_vigencia_final']; 
    const sortColumn = colunasPermitidas.includes(sort) ? sort : 'id';
    const sortOrder = ['asc', 'desc'].includes(order.toLowerCase()) ? order : 'desc';
    const orderByClause = `ORDER BY ${sortColumn} ${sortOrder}`;

    const countSql = `SELECT COUNT(*) AS total FROM Eventos e JOIN Clientes_Eventos c ON e.id_cliente = c.id ${whereClause}`;
    const countRow = await dbGet(countSql, params);
    const total = countRow?.total || 0;
    const totalPages = Math.ceil(total / limitNum);

    const dataSql = `
      SELECT
        e.*, 
        e.emprestimo_tvs AS emprestimo_tvs,
        e.emprestimo_caixas_som AS emprestimo_caixas_som,
        e.emprestimo_microfones AS emprestimo_microfones,
        c.nome_razao_social AS nome_cliente,
        c.tipo_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON e.id_cliente = c.id
        ${whereClause}
       ${orderByClause}
       LIMIT ? OFFSET ?`;
    const rows = await dbAll(dataSql, params.concat([limitNum, offset]));

    for (const evento of rows) {
      if (evento.evento_gratuito == 0 && (!evento.valor_final || evento.valor_final === 0)) {
        let datas = [];
        if (typeof evento.datas_evento === 'string') {
          try { datas = JSON.parse(evento.datas_evento); } 
          catch { datas = evento.datas_evento.split(',').map(s => s.trim()).filter(Boolean); }
        }
        if (Array.isArray(datas) && datas.length > 0) {
            const numDiarias = datas.length;
            const valorBrutoRecalculado = calcularValorBruto(numDiarias);
            const tipoCliente = evento.tipo_cliente || 'Geral';
            const descontoManual = evento.percentual_desconto_manual || 0; 
            evento.valor_final = calcularValorFinal(valorBrutoRecalculado, tipoCliente, descontoManual);
        }
      }
      evento.evento_gratuito = !!evento.evento_gratuito;

      // ===== Agrega status das DARs associadas =====
      try {
        const darStatusRows = await dbAll(
          `SELECT d.status
             FROM DARs_Eventos de
             JOIN dars d ON d.id = de.id_dar
            WHERE de.id_evento = ?`,
          [evento.id],
          'listar-status-dars'
        );

        if (darStatusRows.length) {
          const statuses = darStatusRows.map(r => r.status);
          const allPaid = statuses.every(s => s === 'Pago');
          const anyPaid = statuses.some(s => s === 'Pago');
          let consolidatedStatus = evento.status;
          if (allPaid) consolidatedStatus = 'Pago';
          else if (anyPaid) consolidatedStatus = 'Parcialmente Pago';

          if (consolidatedStatus !== evento.status) {
            evento.status = consolidatedStatus;
            try {
              await dbRun(
                `UPDATE Eventos SET status = ? WHERE id = ?`,
                [consolidatedStatus, evento.id],
                'atualizar-status-evento'
              );
            } catch (e) {
              console.error('[admin/eventos] falha ao persistir status agregado', e.message);
            }
          } else {
            evento.status = consolidatedStatus;
          }
        }
      } catch (e) {
        console.error('[admin/eventos] falha ao agregar status das DARs', e.message);
      }
    }

    res.json({ eventos: rows, totalPages, currentPage: pageNum });

  } catch (err) {
    console.error('[admin/eventos] listar erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor ao buscar eventos.' });
  }
});

/* ===========================================================
   GET /api/admin/eventos/remarcacoes
   Lista eventos com remarcação solicitada
   =========================================================== */
router.get('/remarcacoes', async (req, res) => {
  try {
    const sql = `
      SELECT e.*, e.justificativa_remarcacao, c.nome_razao_social AS nome_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON c.id = e.id_cliente
       WHERE e.remarcacao_solicitada = 1
       ORDER BY e.data_pedido_remarcacao DESC`;
    const rows = await dbAll(sql, [], 'listar-remarcacoes');
    rows.forEach(ev => {
      ev.evento_gratuito = !!ev.evento_gratuito;
      ev.remarcacao_solicitada = !!ev.remarcacao_solicitada;
    });
    res.json({ eventos: rows });
  } catch (err) {
    console.error('[admin/eventos] remarcacoes erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar remarcações.' });
  }
});

/* ===========================================================
   PUT /api/admin/eventos/:id/remarcar
   Aprova ou realiza remarcação de evento
   =========================================================== */
router.put('/:id/remarcar', async (req, res) => {
  try {
    const { id } = req.params;
    let { nova_data, modo } = req.body || {};
    modo = String(modo || '').toLowerCase();
    if (!['aprovar', 'unilateral', 'rejeitar', 'recusar'].includes(modo)) {
      return res.status(400).json({ error: 'Modo inválido. Use aprovar, unilateral ou rejeitar.' });
    }

    const ev = await dbGet(
      `SELECT datas_evento, datas_evento_original, datas_evento_solicitada, remarcacao_solicitada, justificativa_remarcacao
         FROM Eventos WHERE id = ?`,
      [id],
      'remarcar/get-evento'
    );
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });

    if (['aprovar'].includes(modo) && !Number(ev.remarcacao_solicitada)) {
      return res.status(400).json({ error: 'Nenhuma remarcação solicitada.' });
    }

    if (modo === 'rejeitar' || modo === 'recusar') {
      await dbRun(
        `UPDATE Eventos
            SET remarcacao_solicitada = 0,
                datas_evento_solicitada = NULL,
                data_pedido_remarcacao = NULL,
                justificativa_remarcacao = NULL
          WHERE id = ?`,
        [id],
        'remarcar/rejeitar'
      );
      return res.json({ ok: true, rejeitado: true });
    }

    const novaDataFinal = nova_data || ev.datas_evento_solicitada;
    if (!novaDataFinal) {
      return res.status(400).json({ error: 'Nova data não informada.' });
    }

    const datasOrig = ev.datas_evento_original || ev.datas_evento;
    const datasNovas = JSON.stringify([novaDataFinal]);

    await dbRun(
      `UPDATE Eventos
          SET datas_evento_original = ?,
              datas_evento = ?,
              data_vigencia_final = ?,
              remarcado = 1,
              remarcacao_solicitada = 0,
              data_aprovacao_remarcacao = datetime('now'),
              datas_evento_solicitada = NULL,
              justificativa_remarcacao = NULL
        WHERE id = ?`,
      [datasOrig, datasNovas, novaDataFinal, id],
      'remarcar/aprovar'
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/eventos] remarcar erro:', err.message);
    res.status(500).json({ error: 'Erro ao remarcar o evento.' });
  }
});

router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const sql = `
      SELECT
        d.id                                AS id,
        de.numero_parcela                   AS parcela_num,
        COALESCE(de.valor_parcela, d.valor) AS valor,
        d.id                                AS dar_id,
        COALESCE(de.data_vencimento, d.data_vencimento) AS vencimento,
        d.status                            AS status,
        d.pdf_url                           AS pdf_url,
        d.numero_documento                  AS dar_numero
      FROM DARs_Eventos de
      JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY COALESCE(de.numero_parcela, d.id) ASC, d.id ASC`;
    const rows = await dbAll(sql, [eventoId], 'listar-dars-por-evento');

    // fallback para números de parcela ausentes
    let seq = 1;
    for (const r of rows) {
      if (r.parcela_num === null || r.parcela_num === undefined) {
        r.parcela_num = seq;
      }
      seq = r.parcela_num + 1;
    }

    res.json({ dars: rows });
  } catch (err) {
    console.error('[admin/eventos] listar DARs erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
  }
});

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
            COALESCE(de.valor_parcela, d.valor) AS valor,
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
        emprestimo_tvs: ev.emprestimo_tvs,
        emprestimo_caixas_som: ev.emprestimo_caixas_som,
        emprestimo_microfones: ev.emprestimo_microfones,
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
/* ===========================================================
   GET /api/admin/eventos/:id/termo/assinafy-status
   ROTA CORRIGIDA E ADICIONADA
   =========================================================== */
router.get('/:id/termo/assinafy-status', async (req, res) => {
  const { id } = req.params;
  try {
    const row = await dbGet(
      `SELECT assinafy_id, assinatura_url, signed_pdf_public_url FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [id]
    );
    if (!row?.assinafy_id) {
      return res.json({ ok: true, local: { status: 'nao_enviado' } });
    }

    const doc = await getDocument(row.assinafy_id);
    const info = doc?.data || doc;

    // Se o documento já foi certificado, atualizamos nosso banco de dados
    const statusReal = info?.status;
    if (statusReal === 'certified' || statusReal === 'certificated') {
      const bestUrl = pickBestArtifactUrl(info);
      // O ideal é não salvar a URL direta, mas por enquanto vamos manter para consistência
      await dbRun(
        `UPDATE documentos
           SET status = 'assinado',
               signed_pdf_public_url = COALESCE(signed_pdf_public_url, ?),
               signed_at = COALESCE(signed_at, datetime('now'))
         WHERE evento_id = ? AND tipo = 'termo_evento'`,
        [bestUrl || null, id]
      );
    }

    return res.json({ 
      ok: true, 
      assinafy: info, 
      assinatura_url: row.assinatura_url || null,
      signed_pdf_public_url: row.signed_pdf_public_url
    });
  } catch (err) {
    console.error(`[assinafy-status] erro para evento ${id}:`, err.message);
    return res.status(500).json({ ok: false, error: 'Falha ao consultar status no Assinafy.' });
  }
});

module.exports = router;
