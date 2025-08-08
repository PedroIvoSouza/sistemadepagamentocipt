const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// Protege todas as rotas neste arquivo, exigindo um token de admin
router.use(adminAuthMiddleware);

// ROTA PARA LISTAR TODOS OS EVENTOS (GET /api/admin/eventos)
router.get('/', (req, res) => {
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
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("Erro ao buscar eventos:", err.message);
            return res.status(500).json({ error: "Erro interno no servidor ao buscar eventos." });
        }
        res.json(rows);
    });
});

// ROTA PARA CRIAR UM NOVO EVENTO E SUAS DARS (POST /api/admin/eventos)
router.post('/', (req, res) => {
    const {
        idCliente,
        nomeEvento,
        datasEvento, // Espera um array de strings 'YYYY-MM-DD'
        valorBruto,
        valorFinal,
        totalDiarias,
        descontoManualPercent,
        tipoDescontoAuto,
        parcelas // Espera um array de objetos { valor: Number, vencimento: 'YYYY-MM-DD' }
    } = req.body;

    // Validação básica
    if (!idCliente || !nomeEvento || !datasEvento || !parcelas || parcelas.length === 0) {
        return res.status(400).json({ error: "Campos obrigatórios estão faltando." });
    }

    // Usamos uma transação para garantir que tudo seja salvo, ou nada seja.
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const sqlEvento = `
            INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, tipo_desconto, desconto_manual, valor_final, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const paramsEvento = [
            idCliente, nomeEvento, JSON.stringify(datasEvento), totalDiarias, valorBruto, tipoDescontoAuto, descontoManualPercent, valorFinal, 'Pendente'
        ];

        db.run(sqlEvento, paramsEvento, function(err) {
            if (err) {
                console.error("Erro ao inserir evento:", err.message);
                db.run('ROLLBACK');
                return res.status(500).json({ error: "Não foi possível criar o evento." });
            }

            const eventoId = this.lastID;
            let parcelasProcessadas = 0;

            parcelas.forEach((parcela, index) => {
                const sqlDar = `
                    INSERT INTO dars (valor, data_vencimento, status)
                    VALUES (?, ?, ?)
                `;
                db.run(sqlDar, [parcela.valor, parcela.vencimento, 'Pendente'], function(err) {
                    if (err) {
                        console.error("Erro ao inserir DAR:", err.message);
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: `Falha ao criar a DAR da parcela ${index + 1}.` });
                    }
                    
                    const darId = this.lastID;
                    const sqlDarEvento = `
                        INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela)
                        VALUES (?, ?, ?, ?)
                    `;
                    db.run(sqlDarEvento, [darId, eventoId, index + 1, parcela.valor], function(err) {
                        if (err) {
                            console.error("Erro ao associar DAR ao evento:", err.message);
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: `Falha ao associar a DAR da parcela ${index + 1}.` });
                        }
                        
                        parcelasProcessadas++;
                        if (parcelasProcessadas === parcelas.length) {
                            // Se todas as parcelas foram processadas com sucesso, commita a transação
                            db.run('COMMIT');
                            res.status(201).json({ message: "Evento e DARs criados com sucesso!", id: eventoId });
                        }
                    });
                });
            });
        });
    });
});

module.exports = router;