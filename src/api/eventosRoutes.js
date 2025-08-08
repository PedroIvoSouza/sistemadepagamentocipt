// Em: src/api/eventosRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { calcularValorBruto, calcularValorFinal } = require('../services/eventoValorService');
const { emitirGuiaSefaz } = require('../services/sefazService'); // Reutilizamos nosso serviço da SEFAZ

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// Rota para LISTAR todos os eventos (visão geral para o admin)
router.get('/', (req, res) => {
    const sql = `
        SELECT 
            e.id, e.nome_evento, e.status, e.valor_final, e.total_diarias,
            c.nome_razao_social as nome_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON e.id_cliente = c.id
        ORDER BY e.id DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("Erro ao listar eventos:", err.message);
            return res.status(500).json({ error: 'Erro interno no servidor.' });
        }
        res.json(rows);
    });
});


// Rota principal para CRIAR um novo evento e suas DARs
router.post('/', async (req, res) => {
    const {
        idCliente,
        nomeEvento,
        datasEvento, // Espera um array de strings de data: ["2025-10-20", "2025-10-21"]
        tipoDescontoAuto, // 'Geral', 'Governo', 'Permissionario'
        descontoManualPercent,
        parcelas // Espera um array de objetos: [{ valor: 500.50, vencimento: "2025-09-30" }]
    } = req.body;

    // --- Validações Iniciais ---
    if (!idCliente || !nomeEvento || !datasEvento || !datasEvento.length || !parcelas || !parcelas.length) {
        return res.status(400).json({ error: 'Dados insuficientes para criar o evento.' });
    }

    const totalDiarias = datasEvento.length;
    const valorBruto = calcularValorBruto(totalDiarias);
    const valorFinal = calcularValorFinal(valorBruto, tipoDescontoAuto, descontoManualPercent);
    
    const totalParcelado = parcelas.reduce((acc, p) => acc + parseFloat(p.valor), 0);
    if (Math.abs(totalParcelado - valorFinal) > 0.01) { // Tolerância para arredondamento
        return res.status(400).json({ error: `A soma das parcelas (R$ ${totalParcelado.toFixed(2)}) não corresponde ao valor final do evento (R$ ${valorFinal.toFixed(2)}).` });
    }

    // Ordena as datas para garantir que a primeira é a correta
    const datasOrdenadas = datasEvento.sort((a, b) => new Date(a) - new Date(b));
    const primeiraDataEvento = new Date(datasOrdenadas[0]);
    
    const ultimaDataVencimento = new Date(parcelas.sort((a, b) => new Date(b.vencimento) - new Date(a.vencimento))[0].vencimento);

    if (ultimaDataVencimento >= primeiraDataEvento) {
        return res.status(400).json({ error: 'A data de vencimento da última parcela deve ser anterior à data de início do evento.' });
    }
    
    // --- Início do Processo de Criação ---
    db.serialize(async () => {
        db.run('BEGIN TRANSACTION');

        try {
            // 1. Insere o evento principal na tabela Eventos
            const eventoSql = `INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, tipo_desconto_auto, percentual_desconto_manual, valor_final) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            const eventoParams = [idCliente, nomeEvento, datasEvento.join(','), totalDiarias, valorBruto, tipoDescontoAuto, descontoManualPercent, valorFinal];
            
            const eventoId = await new Promise((resolve, reject) => {
                db.run(eventoSql, eventoParams, function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });

            // Busca os dados do cliente para a SEFAZ (apenas uma vez)
            const cliente = await new Promise((resolve, reject) => {
                db.get('SELECT documento, nome_razao_social FROM Clientes_Eventos WHERE id = ?', [idCliente], (err, row) => {
                    if (err) reject(err);
                    else if (!row) reject(new Error('Cliente não encontrado.'));
                    else resolve(row);
                });
            });

            // 2. Itera sobre cada parcela para criar as DARs
            for (let i = 0; i < parcelas.length; i++) {
                const parcela = parcelas[i];
                
                // Monta os dados para a DAR
                const dadosDar = {
                    valor: parcela.valor,
                    data_vencimento: parcela.vencimento,
                    mes_referencia: new Date(parcela.vencimento).getMonth() + 1,
                    ano_referencia: new Date(parcela.vencimento).getFullYear(),
                    status: 'Pendente'
                };
                
                // 3. Chama a API da SEFAZ
                const respostaSefaz = await emitirGuiaSefaz(
                    { 
                        documento: cliente.documento, 
                        nome_empresa: cliente.nome_razao_social 
                    },
                    dadosDar
                    );
                
                // 4. Salva a DAR no nosso banco de dados
                const darSql = `INSERT INTO dars (id_permissionario, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, numero_documento, linha_digitavel, codigo_barras, pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
                const darParams = [null, 'Evento', dadosDar.valor, dadosDar.mes_referencia, dadosDar.ano_referencia, dadosDar.data_vencimento, 'Pendente', respostaSefaz.numeroDocumento, respostaSefaz.linhaDigitavel, respostaSefaz.codigoBarras, respostaSefaz.urlPdf];

                const darId = await new Promise((resolve, reject) => {
                    db.run(darSql, darParams, function(err) {
                        if (err) reject(err);
                        else resolve(this.lastID);
                    });
                });

                // 5. Associa a DAR à parcela do evento
                const darEventoSql = `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`;
                await new Promise((resolve, reject) => {
                    db.run(darEventoSql, [eventoId, darId, i + 1, parcela.valor, parcela.vencimento], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            db.run('COMMIT');
            res.status(201).json({ message: 'Evento e DARs criados com sucesso!', eventoId: eventoId });

        } catch (error) {
            db.run('ROLLBACK');
            console.error("Erro ao criar evento e DARs:", error.message);
            res.status(500).json({ error: `Falha ao criar o evento: ${error.message}` });
        }
    });
});

module.exports = router;