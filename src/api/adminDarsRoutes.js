// Em: src/api/adminDarsRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { enviarEmailNotificacaoDar } = require('../services/emailService');
const { emitirGuiaSefaz } = require('../services/sefazService');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// ROTA PRINCIPAL: GET /api/admin/dars (CÓDIGO COMPLETO RESTAURADO)
router.get('/', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], (req, res) => {
    const { search = '', status = 'todos', mes = 'todos', ano = 'todos', page = 1, limit = 10 } = req.query;

    let sql = `
        SELECT 
            d.id, d.mes_referencia, d.ano_referencia, d.valor,
            d.data_vencimento, d.data_pagamento, d.status,
            p.nome_empresa, p.cnpj
        FROM dars d
        JOIN permissionarios p ON d.permissionario_id = p.id
        WHERE 1=1
    `;
    const params = [];
    
    if (search) {
        sql += ` AND (p.nome_empresa LIKE ? OR p.cnpj LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
    }
    if (status && status !== 'todos') {
        sql += ` AND d.status = ?`;
        params.push(status);
    }
    if (mes && mes !== 'todos') {
        sql += ` AND d.mes_referencia = ?`;
        params.push(mes);
    }
    if (ano && ano !== 'todos') {
        sql += ` AND d.ano_referencia = ?`;
        params.push(ano);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql.trim()})`; // .trim() para segurança

    db.get(countSql, params, (err, countRow) => {
        if (err) {
            console.error('ERRO NO SQL DE CONTAGEM:', err);
            return res.status(500).json({ error: 'Erro ao contar os DARs.' });
        }
        
        const totalItems = countRow.total;
        const totalPages = Math.ceil(totalItems / limit);
        const offset = (page - 1) * limit;

        sql += ` ORDER BY d.ano_referencia DESC, d.mes_referencia DESC, p.nome_empresa LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('ERRO NO SQL DE BUSCA:', err);
                return res.status(500).json({ error: 'Erro ao buscar os DARs.' });
            }
            
            res.status(200).json({
                dars: rows,
                totalPages: totalPages,
                currentPage: Number(page),
                totalItems: totalItems
            });
        });
    });
});


// ROTA PARA ENVIAR NOTIFICAÇÃO (CORRIGIDA)
router.post('/:id/enviar-notificacao', [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])], async (req, res) => {
    const darId = req.params.id;

    // MUDANÇA 1: A consulta agora busca também o email principal (p.email)
    const sql = `
        SELECT 
            d.valor, d.data_vencimento, d.mes_referencia, d.ano_referencia, 
            p.nome_empresa, p.email_notificacao, p.email 
        FROM dars d 
        JOIN permissionarios p ON d.permissionario_id = p.id 
        WHERE d.id = ?`;

    db.get(sql, [darId], async (err, darInfo) => {
        if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
        if (!darInfo) return res.status(404).json({ error: 'DAR não encontrado.' });

        // MUDANÇA 2: Lógica de fallback para o e-mail
        const emailParaEnvio = darInfo.email_notificacao || darInfo.email;

        if (!emailParaEnvio) {
            return res.status(400).json({ error: 'Permissionário não possui e-mail de notificação nem e-mail principal cadastrado.' });
        }

        try {
            const dadosEmail = {
                nome_empresa: darInfo.nome_empresa,
                competencia: `${String(darInfo.mes_referencia).padStart(2, '0')}/${darInfo.ano_referencia}`,
                valor: darInfo.valor,
                data_vencimento: darInfo.data_vencimento
            };
            await enviarEmailNotificacaoDar(emailParaEnvio, dadosEmail);
            res.status(200).json({ message: 'E-mail de notificação enviado com sucesso!' });
        } catch (error) {
            res.status(500).json({ error: 'Falha ao enviar o e-mail.' });
        }
    });
});

// ROTA PARA EMITIR O DAR VIA SEFAZ
router.post('/:id/emitir', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const darId = req.params.id;

    try {
        // 1. Busca os dados do DAR e do Permissionário no nosso banco
        const sql = `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`;
        const dar = await new Promise((resolve, reject) => db.get(sql, [darId, userId], (e, r) => e ? reject(e) : resolve(r)));

        if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

        const sqlUser = `SELECT * FROM permissionarios WHERE id = ?`;
        const user = await new Promise((resolve, reject) => db.get(sqlUser, [userId], (e, r) => e ? reject(e) : resolve(r)));

        // 2. Chama nosso serviço que conversa com a SEFAZ
        const sefazResponse = await emitirGuiaSefaz(user, dar);

        // 3. Retorna a resposta da SEFAZ (com o PDF) para o navegador
        res.status(200).json(sefazResponse);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;