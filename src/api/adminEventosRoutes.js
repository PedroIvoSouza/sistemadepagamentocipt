// Em: src/api/adminEventosRoutes.js
const express = require('express');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const db = require('../database/db');

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

  const {
    idCliente, nomeEvento, datasEvento, totalDiarias, valorBruto,
    tipoDescontoAuto, descontoManualPercent, valorFinal, parcelas,
    numeroProcesso, numeroTermo
  } = req.body;

  if (!idCliente || !nomeEvento || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
  if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
    const errorMsg = `A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`;
    return res.status(400).json({ error: errorMsg });
  }

  try {
    await dbRun('BEGIN TRANSACTION', [], 'criar-evento/BEGIN');

    // FIX: remover "INSERT INTO Eventos (...)" (placeholders inválidos) e listar colunas reais
    const eventoStmt = await dbRun(
      `INSERT INTO Eventos
         (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto,
          tipo_desconto, desconto_manual, valor_final, numero_processo, numero_termo, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idCliente,
        nomeEvento,
        JSON.stringify(datasEvento || []),
        Number(totalDiarias || 0),
        Number(valorBruto || 0),
        String(tipoDescontoAuto || 'Geral'),
        Number(descontoManualPercent || 0),
        Number(valorFinal || 0),
        numeroProcesso || null,
        numeroTermo || null,
        'Pendente'
      ],
      'criar-evento/insert-Eventos'
    );

    const eventoId = eventoStmt.lastID; // FIX: pegar o ID antes do loop

    // Dados do cliente para payload SEFAZ (evita SELECT a cada parcela)
    const cliente = await dbGet(
      `SELECT nome_razao_social, documento, endereco, cep
         FROM Clientes_Eventos WHERE id = ?`,
      [idCliente],
      'criar-evento/select-cliente'
    );
    if (!cliente) throw new Error(`Cliente com ID ${idCliente} não foi encontrado no banco.`);

    const documentoLimpo = onlyDigits(cliente.documento);
    const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;

    // Loop de parcelas
    let ano, mes;
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const valorParcela = Number(p.valor) || 0;
      const vencimentoISO = p.vencimento; // yyyy-mm-dd

      if (!vencimentoISO || Number.isNaN(new Date(`${vencimentoISO}T12:00:00`).getTime())) {
        throw new Error(`A data de vencimento da parcela ${i + 1} é inválida.`);
      }
      if (valorParcela <= 0) {
        throw new Error(`O valor da parcela ${i + 1} deve ser maior que zero.`);
      }

      // FIX: pegar mes/ano corretamente
      [ano, mes] = vencimentoISO.split('-');

      // Cria DAR
      const darStmt = await dbRun(
        `INSERT INTO dars (valor, data_vencimento, status, mes_referencia, ano_referencia)
         VALUES (?, ?, ?, ?, ?)`,
        [valorParcela, vencimentoISO, 'Pendente', Number(mes), Number(ano)],
        `criar-evento/insert-dars#${i + 1}`
      );
      const darId = darStmt.lastID;

      // Vincula DAR ao evento
      await dbRun(
        `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
         VALUES (?, ?, ?, ?, ?)`,
        [darId, eventoId, i + 1, valorParcela, vencimentoISO],
        `criar-evento/insert-join#${i + 1}`
      );

      // Emite guia na SEFAZ
      const payloadSefaz = {
        versao: '1.0',
        contribuinteEmitente: {
          codigoTipoInscricao: tipoInscricao,
          numeroInscricao: documentoLimpo,
          nome: cliente.nome_razao_social,
          codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
          descricaoEndereco: cliente.endereco,
          numeroCep: onlyDigits(cliente.cep)
        },
        receitas: [{
          codigo: Number(process.env.RECEITA_CODIGO_EVENTO),
          competencia: { mes: Number(mes), ano: Number(ano) },
          valorPrincipal: valorParcela,
          valorDesconto: 0.00,
          dataVencimento: vencimentoISO
        }],
        dataLimitePagamento: vencimentoISO,
        observacao: `CIPT Evento: ${nomeEvento} | Parcela ${i + 1} de ${parcelas.length}`
      }; 

      const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);
      const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
      retornoSefaz.pdfBase64 = await imprimirTokenEmPdf(retornoSefaz.pdfBase64, tokenDoc);

      // Atualiza DAR com dados da emissão
      await dbRun(
        `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
        [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId],
        `criar-evento/update-dars-pos-sefaz#${i + 1}`
      );
    }

    await dbRun('COMMIT', [], 'criar-evento/COMMIT');

    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });
  } catch (err) {
    console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
    try { await dbRun('ROLLBACK', [], 'criar-evento/ROLLBACK'); } catch {}
    res.status(500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
  }
});

/**
 * Listar eventos (admin)
 */
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT e.id, e.nome_evento, e.valor_final, e.status,
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
        tipo_cliente: ev.tipo_cliente
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
  // reaproveita a rota acima chamando a própria lógica
  req.url = `/${req.params.id}`; // “redireciona” internamente
  return router.handle(req, res); // delega
});

// PUT /api/admin/eventos/:id  -> atualiza evento e recria/remeite DARs
router.put('/:id', async (req, res) => {
  const { id } = req.params;

  const {
    idCliente,             // obrigatório
    nomeEvento,            // obrigatório
    datasEvento = [],      // array ISO YYYY-MM-DD
    totalDiarias = 0,
    valorBruto = 0,
    tipoDescontoAuto = null,
    descontoManualPercent = 0,
    valorFinal = 0,
    parcelas = [],         // [{ valor, vencimento(YYYY-MM-DD) }, ...]
    numeroProcesso,
    numeroTermo
  } = req.body || {};

  if (!idCliente || !nomeEvento || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
  if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
    return res.status(400).json({
      error: `A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`
    });
  }

  try {
    await dbRun('BEGIN TRANSACTION', [], 'update-evento/BEGIN');

    // 1) Atualiza os campos do evento
    const upd = await dbRun(
      `UPDATE Eventos
          SET id_cliente = ?,
              nome_evento = ?,
              datas_evento = ?,
              total_diarias = ?,
              valor_bruto = ?,
              tipo_desconto = ?,
              desconto_manual = ?,
              valor_final = ?,
              numero_processo = ?,
              numero_termo = ?,
              status = ?
        WHERE id = ?`,
      [
        idCliente,
        nomeEvento,
        JSON.stringify(datasEvento),
        Number(totalDiarias || 0),
        Number(valorBruto || 0),
        tipoDescontoAuto,
        Number(descontoManualPercent || 0),
        Number(valorFinal || 0),
        numeroProcesso || null,
        numeroTermo || null,
        'Pendente',
        id
      ],
      'update-evento/UPDATE-Eventos'
    );

    if (upd.changes === 0) {
      await dbRun('ROLLBACK');
      return res.status(404).json({ error: 'Evento não encontrado.' });
    }

    // 2) Remove DARs antigas (join + DARs)
    const antigos = await dbAll(
      'SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?',
      [id],
      'update-evento/listar-antigos'
    );
    const antigosIds = antigos.map(r => r.id_dar);

    await dbRun('DELETE FROM DARs_Eventos WHERE id_evento = ?', [id], 'update-evento/delete-join');

    if (antigosIds.length) {
      const ph = antigosIds.map(() => '?').join(',');
      await dbRun(`DELETE FROM dars WHERE id IN (${ph})`, antigosIds, 'update-evento/delete-dars');
    }

    // 3) Busca dados do cliente (para payload SEFAZ)
    const cliente = await dbGet(
      `SELECT nome_razao_social, documento, endereco, cep
         FROM Clientes_Eventos
        WHERE id = ?`,
      [idCliente],
      'update-evento/buscar-cliente'
    );
    if (!cliente) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: `Cliente com ID ${idCliente} não encontrado.` });
    }

    // 4) Recria & emite DARs (uma por parcela)
    const onlyDigits = v => String(v || '').replace(/\D/g, '');
    const docLimpo = onlyDigits(cliente.documento);
    const tipoInscricao = docLimpo.length === 11 ? 3 : 4;

    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const valorParcela = Number(p.valor) || 0;
      const vencimentoISO = p.vencimento;

      if (!vencimentoISO || !(new Date(vencimentoISO).getTime() > 0)) {
        throw new Error(`A data de vencimento da parcela ${i + 1} é inválida.`);
      }
      if (valorParcela <= 0) {
        throw new Error(`O valor da parcela ${i + 1} deve ser maior que zero.`);
      }

      const [ano, mes] = vencimentoISO.split('-');

      // cria DAR
      const darStmt = await dbRun(
        `INSERT INTO dars (valor, data_vencimento, status, mes_referencia, ano_referencia)
         VALUES (?, ?, 'Pendente', ?, ?)`,
        [valorParcela, vencimentoISO, Number(mes), Number(ano)],
        `update-evento/insert-dar/${i+1}`
      );
      const darId = darStmt.lastID;

      // vincula à tabela de junção
      await dbRun(
        `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
         VALUES (?, ?, ?, ?, ?)`,
        [darId, id, i + 1, valorParcela, vencimentoISO],
        `update-evento/insert-join/${i+1}`
      );

      // emite na SEFAZ
      const payloadSefaz = {
        versao: '1.0',
        contribuinteEmitente: {
          codigoTipoInscricao: tipoInscricao,
          numeroInscricao: docLimpo,
          nome: cliente.nome_razao_social,
          codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
          descricaoEndereco: cliente.endereco,
          numeroCep: onlyDigits(cliente.cep)
        },
        receitas: [{
          codigo: Number(process.env.RECEITA_CODIGO_EVENTO),
          competencia: { mes: Number(mes), ano: Number(ano) },
          valorPrincipal: valorParcela,
          valorDesconto: 0.00,
          dataVencimento: vencimentoISO
        }],
        dataLimitePagamento: vencimentoISO,
        observacao: `CIPT Evento: ${nomeEvento} | Parcela ${i + 1} de ${parcelas.length} (Atualização)`
      };

      const retorno = await emitirGuiaSefaz(payloadSefaz);
      const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
      retorno.pdfBase64 = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDoc);

      await dbRun(
        `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
        [retorno.numeroGuia, retorno.pdfBase64, darId],
        `update-evento/update-dar/${i+1}`
      );
    }

    await dbRun('COMMIT', [], 'update-evento/COMMIT');
    return res.json({ message: 'Evento atualizado e DARs reemitidas com sucesso.', id: Number(id) });
  } catch (err) {
    console.error('[admin/eventos PUT/:id] erro:', err.message);
    try { await dbRun('ROLLBACK'); } catch {}
    return res.status(500).json({ error: err.message || 'Erro ao atualizar o evento.' });
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
        codigo: Number(process.env.RECEITA_CODIGO_EVENTO),
        competencia: { mes: Number(mes), ano: Number(ano) },
        valorPrincipal: row.valor,
        valorDesconto: 0.00,
        dataVencimento: row.data_vencimento
      }],
      dataLimitePagamento: row.data_vencimento,
      observacao: `CIPT Evento: ${row.nome_evento} | Parcela ${row.numero_parcela}/${row.total_parcelas} (Reemissão)`
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

    const darIds = darsRows.map(r => r.id_dar); // FIX: variável existia sem definição

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

module.exports = router;