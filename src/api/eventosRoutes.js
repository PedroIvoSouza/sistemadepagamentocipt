// Em: src/api/eventosRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { calcularValorBruto, calcularValorFinal } = require('../services/eventoValorService');
const { emitirGuiaSefaz } = require('../services/sefazService'); // Reutilizamos nosso serviço da SEFAZ

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

// Rota para LISTAR todos os eventos (visão geral para o admin)
router.get('/', (req, res) => {
    const sql = `
        SELECT
            e.id,
            e.nome_evento,
            e.espaco_utilizado AS espacos_utilizados,
            e.area_m2,
            e.status,
            e.valor_final,
            e.total_diarias,
            e.data_vigencia_final,
            e.numero_oficio_sei,
            e.numero_processo,
            e.numero_termo,
            e.hora_inicio,
            e.hora_fim,
            e.hora_montagem,
            e.hora_desmontagem,
            c.nome_razao_social AS nome_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON e.id_cliente = c.id
        ORDER BY e.id DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("Erro ao listar eventos:", err.message);
            return res.status(500).json({ error: 'Erro interno no servidor.' });
        }
        rows = rows.map(r => {
            try {
                r.espacos_utilizados = JSON.parse(r.espacos_utilizados || '[]');
            } catch {
                r.espacos_utilizados = [];
            }
            return r;
        });
        res.json(rows);
    });
});


// Rota principal para CRIAR um novo evento e suas DARs
router.post('/', async (req, res) => {
    const {
        idCliente,
        nomeEvento,
        numeroOficioSei,
        espacosUtilizados,
        areaM2,
        datasEvento, // Espera um array de strings de data: ["2025-10-20", "2025-10-21"]
        tipoDescontoAuto, // 'Geral', 'Governo', 'Permissionario'
        descontoManualPercent,
        parcelas, // Espera um array de objetos: [{ valor: 500.50, vencimento: "2025-09-30" }]
        horaInicio,
        horaFim,
        horaMontagem,
        horaDesmontagem,

        numeroProcesso,
        numeroTermo
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
    const dataVigenciaFinal = datasOrdenadas[datasOrdenadas.length - 1];
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

            const eventoSql = `INSERT INTO Eventos (id_cliente, nome_evento, espaco_utilizado, area_m2, datas_evento, data_vigencia_final, total_diarias, valor_bruto, tipo_desconto, desconto_manual, valor_final, numero_oficio_sei, hora_inicio, hora_fim, hora_montagem, hora_desmontagem, numero_processo, numero_termo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            const eventoParams = [
                idCliente,
                nomeEvento,
                JSON.stringify(espacosUtilizados || []),
                areaM2 || null,
                datasEvento.join(','),
                dataVigenciaFinal,
                totalDiarias,
                valorBruto,
                tipoDescontoAuto,
                descontoManualPercent,
                valorFinal,
                numeroOficioSei,
                horaInicio || null,
                horaFim || null,
                horaMontagem || null,
                horaDesmontagem || null,
                numeroProcesso || null,
                numeroTermo || null
            ];
            const eventoId = await new Promise((resolve, reject) => {
                db.run(eventoSql, eventoParams, function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });

            // Busca os dados do cliente para a SEFAZ (apenas uma vez)
            const cliente = await new Promise((resolve, reject) => {
                db.get('SELECT documento, nome_razao_social, endereco, cep FROM Clientes_Eventos WHERE id = ?', [idCliente], (err, row) => {
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
                const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
                if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');
                const payloadSefaz = {
                    versao: '1.0',
                    contribuinteEmitente: {
                        codigoTipoInscricao: onlyDigits(cliente.documento).length === 11 ? 3 : 4,
                        numeroInscricao: onlyDigits(cliente.documento),
                        nome: cliente.nome_razao_social,
                        codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
                        descricaoEndereco: cliente.endereco,
                        numeroCep: onlyDigits(cliente.cep)
                    },
                    receitas: [{
                        codigo: receitaCod,
                        competencia: { mes: dadosDar.mes_referencia, ano: dadosDar.ano_referencia },
                        valorPrincipal: dadosDar.valor,
                        valorDesconto: 0.00,
                        dataVencimento: dadosDar.data_vencimento
                    }],
                    dataLimitePagamento: dadosDar.data_vencimento,
                    observacao: `CIPT Evento: ${nomeEvento} (Montagem ${horaMontagem || '-'}; Evento ${horaInicio || '-'}-${horaFim || '-'}; Desmontagem ${horaDesmontagem || '-'}) | Parcela ${i + 1} de ${parcelas.length}`
                };
                const respostaSefaz = await emitirGuiaSefaz(payloadSefaz);
                
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
