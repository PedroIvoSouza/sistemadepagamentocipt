// Em: src/api/darsRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const authMiddleware = require('../middleware/authMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { emitirGuiaSefaz } = require('../services/sefazService');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// Rota de listagem (sem alterações)
router.get('/', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const { ano, status } = req.query;
    let sql = `SELECT * FROM dars WHERE permissionario_id = ?`;
    const params = [userId];
    if (ano && ano !== 'todos') {
        sql += ` AND ano_referencia = ?`;
        params.push(ano);
    }
    if (status && status !== 'todos') {
        sql += ` AND status = ?`;
        params.push(status);
    }
    sql += ` ORDER BY ano_referencia DESC, mes_referencia DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
        res.status(200).json(rows);
    });
});

// Rota de recálculo para o modal (sem alterações)
router.get('/:id/recalcular', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const darId = req.params.id;
    const sql = `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`;
    db.get(sql, [darId, userId], async (err, dar) => {
        if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
        if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });
        try {
            const calculo = await calcularEncargosAtraso(dar);
            res.status(200).json(calculo);
        } catch (error) {
            res.status(500).json({ error: 'Erro ao calcular encargos.' });
        }
    });
});

// ROTA DE EMISSÃO ATUALIZADA (sem 'termo_permissao')
router.post('/:id/emitir', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const darId = req.params.id;

    try {
        let dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`, [darId, userId]);
        if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

        // MUDANÇA AQUI: A consulta não busca mais o termo_permissao
        const user = await dbGetAsync(`SELECT id, nome_empresa, cnpj FROM permissionarios WHERE id = ?`, [userId]);
        
        let sefazResponse;
        
        if (dar.status === 'Vencido') {
            const calculo = await calcularEncargosAtraso(dar);
            const darAtualizado = {
                ...dar,
                valor: calculo.valorAtualizado,
                data_vencimento: calculo.novaDataVencimento
            };
            sefazResponse = await emitirGuiaSefaz(user, darAtualizado);
        } else {
            sefazResponse = await emitirGuiaSefaz(user, dar);
        }
        
        res.status(200).json(sefazResponse);

    } catch (error) {
        console.error("Erro na rota /emitir:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;