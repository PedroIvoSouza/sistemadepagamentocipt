// Em: src/api/adminEventosRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

// payload builder e config da SEFAZ
const { buildSefazPayloadFromDarEvento } = require('../services/sefazPayloadBuilder');
const { RECEITA_CODIGO_EVENTO } = require('../config/sefaz');

// serviço de emissão (chama a API da SEFAZ)
const { emitirGuiaSefaz } = require('../services/sefazService');

// encargos (opcional, se existir)
let calcularEncargosAtraso = null;
try { ({ calcularEncargosAtraso } = require('../services/cobrancaService')); } catch (_) {}

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// utils
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const isCpf = d => d && d.length === 11;
const isCnpj = d => d && d.length === 14;
const dbGet = (sql, p = []) => new Promise((r, j) => db.get(sql, p, (e, row) => e ? j(e) : r(row)));
const dbAll = (sql, p = []) => new Promise((r, j) => db.all(sql, p, (e, rows) => e ? j(e) : r(rows)));
const dbRun = (sql, p = []) => new Promise((r, j) => db.run(sql, p, function (e) { e ? j(e) : r(this); }));

router.use(adminAuthMiddleware);

// LISTAR eventos (dashboard)
router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT e.id, e.nome_evento, e.valor_final, e.status,
             c.nome_razao_social AS nome_cliente
      FROM Eventos e
      JOIN Clientes_Eventos c ON e.id_cliente = c.id
      ORDER BY e.id DESC
    `;
    const rows = await dbAll(sql);
    res.json(rows);
  } catch (err) {
    console.error('[admin/eventos] listar erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor ao buscar eventos.' });
  }
});

// CRIAR evento + DARs (somente registro local)
router.post('/', async (req, res) => {
  const {
    idCliente, nomeEvento, datasEvento,
    valorBruto, valorFinal, totalDiarias,
    descontoManualPercent, tipoDescontoAuto,
    parcelas
  } = req.body;

  if (!idCliente || !nomeEvento || !Array.isArray(datasEvento) || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  try {
    await dbRun('BEGIN TRANSACTION');

    const eventoStmt = await dbRun(`
      INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, tipo_desconto, desconto_manual, valor_final, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      idCliente, nomeEvento, JSON.stringify(datasEvento),
      totalDiarias || 0, valorBruto || 0, tipoDescontoAuto || null,
      descontoManualPercent || 0, valorFinal || 0, 'Pendente'
    ]);

    const eventoId = eventoStmt.lastID;

    for (let i = 0; i < parcelas.length; i++) {
  const p = parcelas[i];

  // Cria a DAR
  const darStmt = await dbRun(
    `INSERT INTO dars (valor, data_vencimento, status) VALUES (?, ?, ?)`,
    [Number(p.valor) || 0, p.vencimento, 'Pendente']
  );
  const darId = darStmt.lastID;

  // Relaciona a DAR com o evento e registra a data de vencimento também
  await dbRun(
    `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`,
    [darId, eventoId, i + 1, Number(p.valor) || 0, p.vencimento]
  );
}

    await dbRun('COMMIT');
    res.status(201).json({ message: 'Evento e DARs criados com sucesso!', id: eventoId });
  } catch (err) {
    console.error('[admin/eventos] criar erro:', err.message);
    try { await dbRun('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: 'Não foi possível criar o evento.' });
  }
});

// Helper: emitir uma DAR (monta payload SEFAZ e chama o serviço externo)
async function emitirDarByRow(row) {
  if (!row) throw new Error('DAR/Evento não encontrado.');

  // valida documento do contribuinte (CPF/CNPJ)
  let documento = onlyDigits(row.cliente_documento || '');
  if (!isCpf(documento) && !isCnpj(documento)) {
    const who = `cliente_id=${row.cliente_id ?? 'desconhecido'}`;
    const det = row.tipo_pessoa ? ` (tipo_pessoa=${row.tipo_pessoa})` : '';
    const msg = `Documento do contribuinte ausente ou inválido (CPF/CNPJ). ${who}${det}`;
    const e = new Error(msg);
    e.status = 400;
    throw e;
  }

  // base DAR/Parcela
  const valor = Number(row.parcela_valor ?? row.dar_valor ?? 0);
  const venc = row.dar_venc;

  // (opcional) objeto de apoio ao cálculo local — mantido para compatibilidade
  const darForService = {
    id: row.dar_id,
    valor,
    data_vencimento: venc,
    mes_referencia: venc ? new Date(venc).getMonth() + 1 : undefined,
    ano_referencia: venc ? new Date(venc).getFullYear() : undefined,
    status: row.dar_status
  };

  // monta payload da SEFAZ conforme manual
  const payload = buildSefazPayloadFromDarEvento({
    darRow: { id: row.dar_id, valor, data_vencimento: venc, status: row.dar_status },
    eventoRow: { id: row.evento_id, nome_evento: row.evento_nome },
    clienteRow: {
      id: row.cliente_id,
      documento: row.cliente_documento,
      nome_razao_social: row.cliente_nome,
      endereco: row.cliente_endereco,
      cep: row.cliente_cep,
      codigo_ibge_municipio: row.cliente_codigo_ibge || null,
    },
    receitaCodigo: RECEITA_CODIGO_EVENTO,
    dataLimite: venc, // regra simples: igual ao vencimento
  });

  // Encargos de atraso (se existir serviço e a DAR estiver vencida)
  if (darForService.status === 'Vencido' && typeof calcularEncargosAtraso === 'function') {
    try {
      const calc = await calcularEncargosAtraso({
        valor: darForService.valor,
        data_vencimento: darForService.data_vencimento
      });

      const receita0 = payload.receitas[0];
      receita0.valorPrincipal = Number(calc?.valorAtualizado ?? receita0.valorPrincipal);
      payload.dataLimitePagamento = calc?.novaDataVencimento ?? payload.dataLimitePagamento;
      receita0.dataVencimento    = calc?.novaDataVencimento ?? receita0.dataVencimento;
    } catch (e) {
      console.warn('[admin/eventos] encargos: prosseguindo sem atualização:', e?.message);
    }
  }

  // chama serviço que integra com a SEFAZ (agora passando o payload completo)
  const sefaz = await emitirGuiaSefaz(payload);
  return sefaz;
}

// EMITIR por evento + dar
router.post('/:eventoId/dars/:darId/emitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  try {
    const row = await dbGet(
      `
      SELECT 
        d.id AS dar_id,
        d.valor AS dar_valor,
        d.data_vencimento AS dar_venc,
        d.status AS dar_status,

        de.valor_parcela AS parcela_valor,
        de.numero_parcela AS parcela_num,

        e.id AS evento_id,
        e.nome_evento AS evento_nome,
        e.id_cliente,

        c.id AS cliente_id,
        c.nome_razao_social AS cliente_nome,
        c.tipo_pessoa,
        c.documento AS cliente_documento,
        c.endereco  AS cliente_endereco,
        c.cep       AS cliente_cep,
        c.codigo_ibge_municipio AS cliente_codigo_ibge
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      JOIN Eventos e       ON e.id = de.id_evento
      JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE d.id = ? AND e.id = ?
      `,
      [darId, eventoId]
    );

    const sefaz = await emitirDarByRow(row);
    res.json(sefaz);
  } catch (err) {
    const status = err.status || err?.response?.status || 500;
    res.status(status).json({ error: err.message || 'Falha ao emitir a DAR do evento.' });
  }
});

// EMITIR por dar (atalho)
router.post('/dars/:darId/emitir', async (req, res) => {
  const { darId } = req.params;
  try {
    const row = await dbGet(
      `
      SELECT 
        d.id AS dar_id,
        d.valor AS dar_valor,
        d.data_vencimento AS dar_venc,
        d.status AS dar_status,

        de.valor_parcela AS parcela_valor,
        de.numero_parcela AS parcela_num,

        e.id AS evento_id,
        e.nome_evento AS evento_nome,
        e.id_cliente,

        c.id AS cliente_id,
        c.nome_razao_social AS cliente_nome,
        c.tipo_pessoa,
        c.documento AS cliente_documento,
        c.endereco  AS cliente_endereco,
        c.cep       AS cliente_cep,
        c.codigo_ibge_municipio AS cliente_codigo_ibge
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      JOIN Eventos e       ON e.id = de.id_evento
      JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE d.id = ?
      `,
      [darId]
    );

    const sefaz = await emitirDarByRow(row);
    res.json(sefaz);
  } catch (err) {
    const status = err.status || err?.response?.status || 500;
    res.status(status).json({ error: err.message || 'Falha ao emitir a DAR do evento.' });
  }
});

// LISTAR DARs de um evento
router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const rows = await dbAll(
      `
      SELECT
        de.numero_parcela           AS parcela_num,
        de.valor_parcela            AS parcela_valor,
        d.id                        AS dar_id,
        d.valor                     AS dar_valor,
        d.data_vencimento           AS dar_venc,
        d.status                    AS dar_status,
        d.pdf_url                   AS dar_pdf
      FROM DARs_Eventos de
      JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC
      `,
      [eventoId]
    );
    res.json({ dars: rows });
  } catch (err) {
    console.error('[admin/eventos] listar DARs erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
  }
});


module.exports = router;