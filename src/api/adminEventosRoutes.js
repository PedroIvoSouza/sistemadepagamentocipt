// Em: src/api/adminEventosRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// Funções utilitárias para acesso ao banco
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const dbGet = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (err) { (err ? reject(err) : resolve(this)); }));

router.use(adminAuthMiddleware);

// ROTA PARA CRIAR UM NOVO EVENTO E EMITIR TODAS AS DARs
router.post('/', async (req, res) => {
  // CORREÇÃO 1: Capturar TODOS os campos enviados pelo frontend.
  const {
    idCliente,
    nomeEvento,
    datasEvento,
    totalDiarias,
    valorBruto,
    tipoDescontoAuto,
    descontoManualPercent,
    valorFinal,
    parcelas
  } = req.body;

  if (!idCliente || !nomeEvento || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios (cliente, nome do evento, parcelas) estão faltando.' });
  }

  try {
    await dbRun('BEGIN TRANSACTION');

    // CORREÇÃO 2: Incluir TODAS as colunas e valores no comando INSERT.
    const eventoStmt = await dbRun(
      `INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, tipo_desconto, desconto_manual, valor_final, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idCliente,
        nomeEvento,
        JSON.stringify(datasEvento),
        totalDiarias,
        valorBruto,
        tipoDescontoAuto,
        descontoManualPercent,
        valorFinal,
        'Pendente'
      ]
    );
    const eventoId = eventoStmt.lastID;

    // O restante da lógica para processar as parcelas e emitir na SEFAZ.
    for (let i = 0; i < parcelas.length; i++) {
        const p = parcelas[i];
        const valorParcela = Number(p.valor) || 0;
        const vencimentoISO = p.vencimento;

        if (!vencimentoISO || valorParcela <= 0) {
            throw new Error(`Dados da parcela ${i + 1} são inválidos.`);
        }

        const darStmt = await dbRun(
            `INSERT INTO dars (valor, data_vencimento, status) VALUES (?, ?, ?)`,
            [valorParcela, vencimentoISO, 'Pendente']
        );
        const darId = darStmt.lastID;

        await dbRun(
            `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`,
            [darId, eventoId, i + 1, valorParcela, vencimentoISO]
        );

        const cliente = await dbGet(`SELECT nome_razao_social, documento, endereco, cep, codigo_ibge_municipio FROM Clientes_Eventos WHERE id = ?`, [idCliente]);
        if (!cliente) throw new Error(`Cliente com ID ${idCliente} não foi encontrado no banco.`);

        const documentoLimpo = onlyDigits(cliente.documento);
        const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
        const [ano, mes] = vencimentoISO.split('-');
        
        const payloadSefaz = {
            versao: "1.0",
            contribuinteEmitente: {
                codigoTipoInscricao: tipoInscricao,
                numeroInscricao: documentoLimpo,
                nome: cliente.nome_razao_social,
                codigoIbgeMunicipio: Number(cliente.codigo_ibge_municipio),
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

        await dbRun(
            `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
            [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId]
        );
    }

    await dbRun('COMMIT');
    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });

  } catch (err) {
    console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
    await dbRun('ROLLBACK');
    res.status(500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
  }
});

// LISTAR eventos (dashboard)
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

// LISTAR DARs de um evento específico
router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const rows = await dbAll(
      `
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

// ROTA PARA REEMITIR UMA ÚNICA DAR (ex: vencida ou com falha)
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  res.status(501).json({ error: 'Rota de re-emissão ainda não implementada.' });
});

module.exports = router;