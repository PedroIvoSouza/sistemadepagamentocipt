// Em: src/api/adminEventosRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
// Importa o sefazService, que agora só se preocupa com a comunicação
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
  const {
    idCliente, nomeEvento, datasEvento, valorFinal, parcelas
  } = req.body;

  if (!idCliente || !nomeEvento || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios (cliente, nome do evento, parcelas) estão faltando.' });
  }

  try {
    // Inicia a transação para garantir que tudo seja salvo ou nada
    await dbRun('BEGIN TRANSACTION');

    // 1. Insere o Evento principal no banco de dados
    const eventoStmt = await dbRun(
      `INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, valor_final, status) VALUES (?, ?, ?, ?, ?)`,
      [idCliente, nomeEvento, JSON.stringify(datasEvento), valorFinal, 'Pendente']
    );
    const eventoId = eventoStmt.lastID;

    // 2. Itera sobre cada parcela recebida do frontend
    for (let i = 0; i < parcelas.length; i++) {
        const p = parcelas[i];
        const valorParcela = Number(p.valor) || 0;
        const vencimentoISO = p.vencimento; // Formato esperado: YYYY-MM-DD

        if (!vencimentoISO || valorParcela <= 0) {
            throw new Error(`Dados da parcela ${i + 1} são inválidos.`);
        }

        // 2.1. Cria a DAR correspondente no banco
        const darStmt = await dbRun(
            `INSERT INTO dars (valor, data_vencimento, status) VALUES (?, ?, ?)`,
            [valorParcela, vencimentoISO, 'Pendente']
        );
        const darId = darStmt.lastID;

        // 2.2. Cria o vínculo entre a DAR e o Evento
        await dbRun(
            `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`,
            [darId, eventoId, i + 1, valorParcela, vencimentoISO]
        );

        // 2.3. Busca os dados do cliente para montar o payload da SEFAZ
        const cliente = await dbGet(`SELECT nome_razao_social, documento, endereco, cep, codigo_ibge_municipio FROM Clientes_Eventos WHERE id = ?`, [idCliente]);
        if (!cliente) throw new Error(`Cliente com ID ${idCliente} não foi encontrado no banco.`);

        // =================== MONTAGEM DO PAYLOAD PARA A SEFAZ ===================
        const documentoLimpo = onlyDigits(cliente.documento);
        const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4; // 3 para CPF, 4 para CNPJ

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
                codigo: Number(process.env.RECEITA_CODIGO_EVENTO), // Ex: 20165
                competencia: {
                    mes: Number(mes),
                    ano: Number(ano)
                },
                valorPrincipal: valorParcela,
                valorDesconto: 0.00, // Descontos já foram aplicados no valorFinal, então aqui é 0
                dataVencimento: vencimentoISO
            }],
            dataLimitePagamento: vencimentoISO,
            observacao: `CIPT Evento: ${nomeEvento} | Parcela ${i + 1} de ${parcelas.length}`
        };
        // =========================================================================

        // 2.4. Chama o serviço para emitir a guia na SEFAZ
        const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);

        // 2.5. Atualiza a nossa DAR com os dados retornados pela SEFAZ
        await dbRun(
            `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
            // O manual da SEFAZ indica que o PDF vem em Base64. Salvaremos isso por enquanto.
            [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId]
        );
    }

    // Se tudo deu certo, confirma a transação
    await dbRun('COMMIT');
    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });

  } catch (err) {
    console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
    // Em caso de qualquer erro, desfaz todas as operações no banco
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
        d.pdf_url AS dar_pdf  -- Campo onde o pdfBase64 foi salvo
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
  try {
      // 1. Busca todos os dados necessários com um JOIN
      const row = await dbGet(`
          SELECT
              e.nome_evento,
              de.numero_parcela,
              (SELECT COUNT(*) FROM DARs_Eventos WHERE id_evento = e.id) as total_parcelas,
              d.valor, d.data_vencimento,
              c.nome_razao_social, c.documento, c.endereco, c.cep, c.codigo_ibge_municipio
          FROM dars d
          JOIN DARs_Eventos de ON d.id = de.id_dar
          JOIN Eventos e ON de.id_evento = e.id
          JOIN Clientes_Eventos c ON e.id_cliente = c.id
          WHERE d.id = ? AND e.id = ?
      `, [darId, eventoId]);

      if (!row) {
          return res.status(404).json({ error: 'DAR ou Evento não encontrado.' });
      }

      // 2. Monta o payload (lógica idêntica à da criação)
      const documentoLimpo = onlyDigits(row.documento);
      const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
      const [ano, mes] = row.data_vencimento.split('-');

      const payloadSefaz = {
          versao: "1.0",
          contribuinteEmitente: { /* ... preencher como na rota de criação ... */ },
          receitas: [ /* ... preencher como na rota de criação ... */ ],
          dataLimitePagamento: row.data_vencimento,
          observacao: `CIPT Evento: ${row.nome_evento} | Parcela ${row.numero_parcela} de ${row.total_parcelas} (Reemissão)`
      };
      // ... (complete o payloadSefaz com os dados de `row`)

      // 3. Chama o serviço da SEFAZ
      const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);

      // 4. Atualiza a DAR no banco
      await dbRun(
          `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`,
          [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId]
      );
      
      res.json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });

  } catch (err) {
      console.error(`[ERRO] Ao reemitir DAR ${darId}:`, err.message);
      res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});


module.exports = router;