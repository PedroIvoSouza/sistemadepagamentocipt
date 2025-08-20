const express = require('express');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { gerarTermoPermissao } = require('../services/termoService'); // (mantido para compat)
const { gerarTermoEventoEIndexar } = require('../services/termoEventoExportService');
const db = require('../database/db');
const fs = require('fs');
const path = require('path');
const { criarEventoComDars, atualizarEventoComDars } = require('../services/eventoDarService');
const { gerarTermoEventoEIndexar } = require('../services/termoEventoExportService');


const router = express.Router();

// Helpers com logging
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

const dbGet = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][GET]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.get(sql, p, (err, row) => {
      if (err) {
        console.error('[SQL][GET][ERRO]', ctx, err.message);
        return reject(err);
      }
      console.log('[SQL][GET][OK]', ctx, 'row:', row);
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
      resolve(this); // this.lastID / this.changes ficam disponíveis
    });
  });

router.use(adminAuthMiddleware);

/**
 * Criar evento + emitir DARs
 */
router.post('/', async (req, res) => {
  console.log('[DEBUG] Recebido no backend /api/admin/eventos:', JSON.stringify(req.body, null, 2));
  try {
    const eventoId = await criarEventoComDars(db, req.body, {
      emitirGuiaSefaz,
      gerarTokenDocumento,
      imprimirTokenEmPdf,
    });
    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });
  } catch (err) {
    console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
  }
});

/**
 * Listar eventos (admin)
 */
router.get('/', async (req, res) => {
  try {
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

/**
 * Listar DARs de um evento
 */
router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const rows = await dbAll(
      `SELECT
         de.numero_parcela,
         de.valor_parcela,
         d.id AS dar_id,
         d.data_vencimento AS dar_venc,
         d.status AS dar_status,
         d.pdf_url AS dar_pdf
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`,
      [eventoId],
      'listar-dars-por-evento'
    );
    res.json({ dars: rows });
  } catch (err) {
    console.error('[admin/eventos] listar DARs erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
  }
});

// GET /api/admin/eventos/:id  -> detalhes do evento para edição
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const ev = await dbGet(
      `SELECT e.*, c.nome_razao_social AS nome_cliente, c.tipo_cliente
         FROM Eventos e
         JOIN Clientes_Eventos c ON c.id = e.id_cliente
        WHERE e.id = ?`,
      [id],
      'evento/get-by-id'
    );

    if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });

    // Normaliza datas_evento (pode ter sido salvo como JSON string)
    let datas = [];
    try {
      if (typeof ev.datas_evento === 'string') {
        datas = ev.datas_evento.trim().startsWith('[')
          ? JSON.parse(ev.datas_evento)
          : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(ev.datas_evento)) {
        datas = ev.datas_evento;
      }
    } catch { /* mantém vazio */ }

    const parcelas = await dbAll(
      `SELECT 
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
        ORDER BY de.numero_parcela ASC`,
      [id],
      'evento/get-parcelas'
    );

    // Resposta no formato que seu front espera (normalizarEvento)
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
        status: ev.status,
        nome_cliente: ev.nome_cliente,
        tipo_cliente: ev.tipo_cliente,
        hora_inicio: ev.hora_inicio,
        hora_fim: ev.hora_fim,
        hora_montagem: ev.hora_montagem,
        hora_desmontagem: ev.hora_desmontagem
      },
      parcelas: parcelas
    };

    return res.json(payload);
  } catch (err) {
    console.error('[admin/eventos/:id] erro:', err.message);
    return res.status(500).json({ error: 'Erro interno ao buscar o evento.' });
  }
});

// GET /api/admin/eventos/:id/detalhes  -> alias para o mesmo payload
router.get('/:id/detalhes', async (req, res) => {
  req.url = `/${req.params.id}`;
  return router.handle(req, res);
});

// PUT /api/admin/eventos/:id  -> atualiza evento e recria/remeite DARs
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await atualizarEventoComDars(db, id, req.body, {
      emitirGuiaSefaz,
      gerarTokenDocumento,
      imprimirTokenEmPdf,
    });
    return res.json({ message: 'Evento atualizado e DARs reemitidas com sucesso.', id: Number(id) });
  } catch (err) {
    console.error('[admin/eventos PUT/:id] erro:', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Erro ao atualizar o evento.' });
  }
});

/**
 * Reemitir DAR específica
 */
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  console.log(`[ADMIN] Reemitir DAR ID: ${darId} do Evento ID: ${eventoId}`);

  try {
    const row = await dbGet(
      `
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
       WHERE d.id = ? AND e.id = ?
      `,
      [darId, eventoId],
      'reemitir/buscar-contexto'
    );

    if (!row) return res.status(404).json({ error: 'DAR ou Evento não encontrado.' });

    const documentoLimpo = onlyDigits(row.documento);
    const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
    const [ano, mes] = row.data_vencimento.split('-');

    const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
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

    await dbRun(
      `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`,
      [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId],
      'reemitir/update-dars'
    );

    console.log(`[ADMIN] DAR ID: ${darId} reemitida. Novo número: ${retornoSefaz.numeroGuia}`);
    res.status(200).json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });
  } catch (err) {
    console.error(`[ERRO] Ao reemitir DAR ID ${darId}:`, err.message);
    res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

/**
 * Apagar evento + suas DARs
 */
router.delete('/:eventoId', async (req, res) => {
  const { eventoId } = req.params;
  console.log(`[ADMIN] Apagar evento ID: ${eventoId}`);

  try {
    await dbRun('BEGIN TRANSACTION', [], 'apagar/BEGIN');

    const darsRows = await dbAll(
      'SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?',
      [eventoId],
      'apagar/listar-vinculos'
    );

    const darIds = darsRows.map(r => r.id_dar);

    await dbRun(
      'DELETE FROM DARs_Eventos WHERE id_evento = ?',
      [eventoId],
      'apagar/delete-join'
    );

    if (darIds.length) {
      const placeholders = darIds.map(() => '?').join(',');
      await dbRun(
        `DELETE FROM dars WHERE id IN (${placeholders})`,
        darIds,
        'apagar/delete-dars'
      );
    }

    const result = await dbRun(
      'DELETE FROM Eventos WHERE id = ?',
      [eventoId],
      'apagar/delete-evento'
    );

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

/**
 * NOVO: disponibiliza o termo do evento (gera PDF + indexa + retorna URL pública/visualização)
 */
router.post('/:eventoId/termo/disponibilizar', async (req, res) => {
  try {
    const { eventoId } = req.params;

    const out = await gerarTermoEventoEIndexar(eventoId);

    // garante status 'gerado' (idempotente)
    await dbRun(`UPDATE documentos SET status = 'gerado' WHERE id = ?`, [out.documentoId], 'termo/status-gerado');

    return res.json({
      ok: true,
      documentoId: out.documentoId,
      pdf_url: out.pdf_public_url,
      url_visualizacao: out.urlTermoPublic
    });
  } catch (err) {
    console.error('[admin disponibilizar termo] erro:', err);
    return res.status(500).json({ ok:false, error: 'Falha ao disponibilizar termo.' });
  }
});

/**
 * (Opcional/Compat) Gera e BAIXA o termo imediatamente.
 * Agora redireciona para o pipeline novo: gera, salva em /public/documentos e devolve o arquivo.
 */
router.get('/:id/termo', async (req, res) => {
  const { id } = req.params;
  try {
    // Gera, salva em /public/documentos e indexa na tabela `documentos`
    const out = await gerarTermoEventoEIndexar(id);

    // Faz o download do PDF para o ADM
    const stat = fs.statSync(out.filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(out.filePath).pipe(res);
  } catch (err) {
    console.error('[admin/eventos] termo erro:', err.message);
    res.status(500).json({ error: 'Falha ao gerar termo' });
  }
});

module.exports = router;
