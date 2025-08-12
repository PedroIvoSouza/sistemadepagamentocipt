// Em: src/api/adminEventosRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const dbGet = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (err) { (err ? reject(err) : resolve(this)); }));

router.use(adminAuthMiddleware);

router.post('/', async (req, res) => {
  console.log('[DEBUG] Recebido no backend /api/admin/eventos:', JSON.stringify(req.body, null, 2));

  const {
    idCliente, nomeEvento, datasEvento, totalDiarias, valorBruto,
    tipoDescontoAuto, descontoManualPercent, valorFinal, parcelas
  } = req.body;

  if (!idCliente || !nomeEvento || !Array.isArray(parcelas) || parcelas.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
  if (Math.abs(somaParcelas - valorFinal) > 0.01) {
      const errorMsg = `A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${valorFinal.toFixed(2)}).`;
      return res.status(400).json({ error: errorMsg });
  }

  try {
    await dbRun('BEGIN TRANSACTION');

    const eventoStmt = await dbRun(
      `INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, tipo_desconto, desconto_manual, valor_final, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idCliente, nomeEvento, JSON.stringify(datasEvento), totalDiarias, valorBruto, tipoDescontoAuto, descontoManualPercent, valorFinal, 'Pendente']
    );
    const eventoId = eventoStmt.lastID;

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

        const darStmt = await dbRun(`INSERT INTO dars (valor, data_vencimento, status) VALUES (?, ?, ?)`, [valorParcela, vencimentoISO, 'Pendente']);
        const darId = darStmt.lastID;

        await dbRun(`INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`, [darId, eventoId, i + 1, valorParcela, vencimentoISO]);
        
        const cliente = await dbGet(`SELECT nome_razao_social, documento, endereco, cep FROM Clientes_Eventos WHERE id = ?`, [idCliente]);
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

        await dbRun(`UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`, [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId]);
    }

    await dbRun('COMMIT');
    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });

  } catch (err) {
    console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
    await dbRun('ROLLBACK');
    res.status(500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const sql = `SELECT e.id, e.nome_evento, e.valor_final, e.status, c.nome_razao_social AS nome_cliente FROM Eventos e JOIN Clientes_Eventos c ON e.id_cliente = c.id ORDER BY e.id DESC`;
    const rows = await dbAll(sql);
    res.json(rows);
  } catch (err) {
    console.error('[admin/eventos] listar erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor ao buscar eventos.' });
  }
});

router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const rows = await dbAll(`SELECT de.numero_parcela, de.valor_parcela, d.id AS dar_id, d.data_vencimento AS dar_venc, d.status AS dar_status, d.pdf_url AS dar_pdf FROM DARs_Eventos de JOIN dars d ON d.id = de.id_dar WHERE de.id_evento = ? ORDER BY de.numero_parcela ASC`, [eventoId]);
    res.json({ dars: rows });
  } catch (err) {
    console.error('[admin/eventos] listar DARs erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
  }
});

// ROTA PARA REEMITIR UMA ÚNICA DAR
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  console.log(`[ADMIN] Recebida requisição para REEMITIR DAR ID: ${darId} do Evento ID: ${eventoId}`);

  try {
    // 1. Busca todos os dados necessários com um JOIN
    const row = await dbGet(`
        SELECT
            e.nome_evento,
            de.numero_parcela,
            (SELECT COUNT(*) FROM DARs_Eventos WHERE id_evento = e.id) as total_parcelas,
            d.valor, d.data_vencimento,
            c.nome_razao_social, c.documento, c.endereco, c.cep
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

    // 3. Chama o serviço da SEFAZ
    const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);

    // 4. Atualiza a DAR no banco com os novos dados
    await dbRun(
        `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`,
        [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId]
    );
    
    console.log(`[ADMIN] DAR ID: ${darId} reemitida com sucesso. Novo número: ${retornoSefaz.numeroGuia}`);
    res.status(200).json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });

  } catch (err) {
      console.error(`[ERRO] Ao reemitir DAR ID ${darId}:`, err.message);
      res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

// ROTA PARA APAGAR UM EVENTO E SUAS DARS ASSOCIADAS
router.delete('/:eventoId', async (req, res) => {
  const { eventoId } = req.params;

  console.log(`[ADMIN] Recebida requisição para apagar evento ID: ${eventoId}`);

  try {
    // Usamos uma transação para garantir a integridade dos dados
    await dbRun('BEGIN TRANSACTION');

    // 1. Encontra todos os IDs das DARs associadas ao evento
    const darsRows = await dbAll('SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?', [eventoId]);
    const darIds = darsRows.map(row => row.id_dar);

    if (darIds.length > 0) {
      // 2. Apaga os vínculos na tabela DARs_Eventos
      await dbRun(`DELETE FROM DARs_Eventos WHERE id_evento = ?`, [eventoId]);

      // 3. Apaga as DARs da tabela principal 'dars'
      // O '?' será substituído por uma lista de IDs (ex: 1, 2, 3)
      const placeholders = darIds.map(() => '?').join(',');
      await dbRun(`DELETE FROM dars WHERE id IN (${placeholders})`, darIds);
    }

    // 4. Finalmente, apaga o evento da tabela 'Eventos'
    const result = await dbRun('DELETE FROM Eventos WHERE id = ?', [eventoId]);

    if (result.changes === 0) {
      throw new Error('Nenhum evento encontrado com este ID.');
    }

    // Se tudo deu certo, confirma a transação
    await dbRun('COMMIT');

    console.log(`[ADMIN] Evento ID: ${eventoId} e suas ${darIds.length} DARs foram apagados com sucesso.`);
    res.status(200).json({ message: 'Evento e DARs associadas apagados com sucesso!' });

  } catch (err) {
    // Em caso de qualquer erro, desfaz tudo
    await dbRun('ROLLBACK');
    console.error(`[ERRO] Ao apagar evento ID ${eventoId}:`, err.message);
    res.status(500).json({ error: 'Falha ao apagar o evento.' });
  }
});

module.exports = router;