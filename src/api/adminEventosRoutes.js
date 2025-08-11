// Em: src/api/adminEventosRoutes.js
// Rotas de administração de EVENTOS (inclui emissão de DARs de eventos - CPF/CNPJ)

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');
let calcularEncargosAtraso = null;
try {
  // opcional: só existe se você usa isso para permissionários
  ({ calcularEncargosAtraso } = require('../services/cobrancaService'));
} catch (_) {}

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// util
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

// Protege tudo: só ADMIN
router.use(adminAuthMiddleware);

/**
 * LISTAR eventos (GET /api/admin/eventos)
 */
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT 
        e.id,
        e.nome_evento,
        e.valor_final,
        e.status,
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

/**
 * CRIAR evento + DARs (POST /api/admin/eventos)
 * body: { idCliente, nomeEvento, datasEvento[], valorBruto, valorFinal, totalDiarias, descontoManualPercent, tipoDescontoAuto, parcelas[] }
 * parcelas: [{ valor, vencimento:'YYYY-MM-DD' }]
 */
router.post('/', async (req, res) => {
  const {
    idCliente,
    nomeEvento,
    datasEvento,
    valorBruto,
    valorFinal,
    totalDiarias,
    descontoManualPercent,
    tipoDescontoAuto,
    parcelas
  } = req.body;

  if (!idCliente || !nomeEvento || !Array.isArray(datasEvento) || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  try {
    await dbRun('BEGIN TRANSACTION');

    const insertEvento = `
      INSERT INTO Eventos (
        id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, 
        tipo_desconto, desconto_manual, valor_final, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const eventoStmt = await dbRun(insertEvento, [
      idCliente,
      nomeEvento,
      JSON.stringify(datasEvento),
      totalDiarias || 0,
      valorBruto || 0,
      tipoDescontoAuto || null,
      descontoManualPercent || 0,
      valorFinal || 0,
      'Pendente'
    ]);

    const eventoId = eventoStmt.lastID;

    // cria DARs
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const insertDar = `INSERT INTO dars (valor, data_vencimento, status) VALUES (?, ?, ?)`;
      const darStmt = await dbRun(insertDar, [Number(p.valor) || 0, p.vencimento, 'Pendente']);
      const darId = darStmt.lastID;

      const vinc = `
        INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela)
        VALUES (?, ?, ?, ?)
      `;
      await dbRun(vinc, [darId, eventoId, i + 1, Number(p.valor) || 0]);
    }

    await dbRun('COMMIT');
    res.status(201).json({ message: 'Evento e DARs criados com sucesso!', id: eventoId });
  } catch (err) {
    console.error('[admin/eventos] criar erro:', err.message);
    try { await dbRun('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: 'Não foi possível criar o evento.' });
  }
});

/**
 * EMITIR DAR de evento (POST /api/admin/eventos/:eventoId/dars/:darId/emitir)
 * Usa CPF ou CNPJ do cliente do evento automaticamente.
 */
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
        e.nome_evento,
        e.id_cliente,

        c.nome_razao_social AS nome_cliente,
        c.tipo_pessoa,
        c.documento
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      JOIN Eventos e       ON e.id = de.id_evento
      JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE d.id = ? AND e.id = ?
      `,
      [darId, eventoId]
    );

    if (!row) return res.status(404).json({ error: 'DAR/Evento não encontrado.' });

    // Decide valor e vencimento
    const valor = Number(row.parcela_valor ?? row.dar_valor ?? 0);
    const venc = row.dar_venc;

    // Monta um objeto "dar" no formato esperado pelo serviço (mínimo necessário)
    const darForService = {
      id: row.dar_id,
      valor,
      data_vencimento: venc,
      mes_referencia: venc ? new Date(venc).getMonth() + 1 : undefined,
      ano_referencia: venc ? new Date(venc).getFullYear() : undefined,
      status: row.dar_status
    };

    // Em caso de vencida e se você usa cálculo de encargos:
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
        console.warn('[admin/eventos] não foi possível calcular encargos, seguindo sem atualização:', e?.message);
      }
    }

    // Overrides para CPF/CNPJ e Nome (o serviço detecta o tipo automaticamente)
    const overrides = {
      documento: onlyDigits(row.documento),
      nome: row.nome_cliente
    };

    const sefaz = await emitirGuiaSefaz(null, enviar, overrides);
    return res.json(sefaz);
  } catch (err) {
    console.error('[admin/eventos] emitir DAR erro:', err);
    const msg = err?.message || 'Falha ao emitir a DAR do evento.';
    return res.status(500).json({ error: msg });
  }
});

/**
 * EMITIR DAR de evento (ATALHO) (POST /api/admin/eventos/dars/:darId/emitir)
 * Descobre o evento automaticamente a partir da DAR.
 */
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
        e.nome_evento,
        e.id_cliente,

        c.nome_razao_social AS nome_cliente,
        c.tipo_pessoa,
        c.documento
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      JOIN Eventos e       ON e.id = de.id_evento
      JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE d.id = ?
      `,
      [darId]
    );

    if (!row) return res.status(404).json({ error: 'DAR de evento não encontrada.' });

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
        console.warn('[admin/eventos] (atalho) não foi possível calcular encargos, seguindo sem atualização:', e?.message);
      }
    }

    const overrides = {
      documento: onlyDigits(row.documento),
      nome: row.nome_cliente
    };

    const sefaz = await emitirGuiaSefaz(null, enviar, overrides);
    return res.json(sefaz);
  } catch (err) {
    console.error('[admin/eventos] (atalho) emitir DAR erro:', err);
    const msg = err?.message || 'Falha ao emitir a DAR do evento.';
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
