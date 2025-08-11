// Em: src/api/adminEventosRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');
let calcularEncargosAtraso = null;
try { ({ calcularEncargosAtraso } = require('../services/cobrancaService')); } catch (_) {}

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// util
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const isCpf = d => d && d.length === 11;
const isCnpj = d => d && d.length === 14;
const dbGet = (sql, p = []) => new Promise((r, j) => db.get(sql, p, (e, row) => e ? j(e) : r(row)));
const dbAll = (sql, p = []) => new Promise((r, j) => db.all(sql, p, (e, rows) => e ? j(e) : r(rows)));
const dbRun = (sql, p = []) => new Promise((r, j) => db.run(sql, p, function (e) { e ? j(e) : r(this); }));

router.use(adminAuthMiddleware);

// listar
router.get('/', async (req, res) => {
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

// criar
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
      const darStmt = await dbRun(
        `INSERT INTO dars (valor, data_vencimento, status) VALUES (?, ?, ?)`,
        [Number(p.valor) || 0, p.vencimento, 'Pendente']
      );
      const darId = darStmt.lastID;
      await dbRun(
        `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela) VALUES (?, ?, ?, ?)`,
        [darId, eventoId, i + 1, Number(p.valor) || 0]
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

// helper emissão (evita código duplicado)
async function emitirDarByRow(row) {
  if (!row) throw new Error('DAR/Evento não encontrado.');

  let documento = onlyDigits(row.documento || '');
  if (!isCpf(documento) && !isCnpj(documento)) {
    const who = `cliente_id=${row.id_cliente ?? 'desconhecido'}`;
    const det = row.tipo_pessoa ? ` (tipo_pessoa=${row.tipo_pessoa})` : '';
    const msg = `Documento do contribuinte ausente ou inválido (CPF/CNPJ). ${who}${det}`;
    const e = new Error(msg);
    e.status = 400;
    throw e;
  }

  const valor = Number(row.parcela_valor ?? row.dar_valor ?? 0);
  const venc = row.dar_venc;

  const darForService = {
    id: row.dar_id,
    valor,
    data_vencimento: venc,
    mes_referencia: venc ? new Date(venc).getMonth() + 1 : undefined,
    ano_referencia: venc ? new Date(venc).getFullYear() : undefined,
    status: row.dar_status
  };

  let enviar = darForService;
  if (darForService.status === 'Vencido' && typeof calcularEncargosAtraso === 'function') {
    try {
      const calc = await calcularEncargosAtraso({
        valor: darForService.valor,
        data_vencimento: darForService.data_vencimento
      });
      enviar = {
        ...darForService,
        valor: calc?.valorAtualizado ?? darForService.valor,
        data_vencimento: calc?.novaDataVencimento ?? darForService.data_vencimento
      };
    } catch (e) {
      console.warn('[admin/eventos] encargos: prosseguindo sem atualização:', e?.message);
    }
  }

  const overrides = { documento, nome: row.nome_cliente };
  return emitirGuiaSefaz(null, enviar, overrides);
}

// emitir por evento+dar
router.post('/:eventoId/dars/:darId/emitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  try {
    const row = await dbGet(
      `
      SELECT 
        d.id AS dar_id, d.valor AS dar_valor, d.data_vencimento AS dar_venc, d.status AS dar_status,
        de.valor_parcela AS parcela_valor, de.numero_parcela AS parcela_num,
        e.id AS evento_id, e.nome_evento, e.id_cliente,
        c.id AS cliente_id, c.nome_razao_social AS nome_cliente, c.tipo_pessoa, c.documento
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
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Falha ao emitir a DAR do evento.' });
  }
});

// emitir por dar (atalho)
router.post('/dars/:darId/emitir', async (req, res) => {
  const { darId } = req.params;
  try {
    const row = await dbGet(
      `
      SELECT 
        d.id AS dar_id, d.valor AS dar_valor, d.data_vencimento AS dar_venc, d.status AS dar_status,
        de.valor_parcela AS parcela_valor, de.numero_parcela AS parcela_num,
        e.id AS evento_id, e.nome_evento, e.id_cliente,
        c.id AS cliente_id, c.nome_razao_social AS nome_cliente, c.tipo_pessoa, c.documento
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
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Falha ao emitir a DAR do evento.' });
  }
});

module.exports = router;
