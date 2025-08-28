// Em: src/api/adminManagementRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { enviarEmailPrimeiroAcesso } = require('../services/emailService');
const jwt = require('jsonwebtoken');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// Roles válidas para administradores do sistema
const VALID_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'SALAS_ADMIN'];

// ROTA PARA LISTAR TODOS OS ADMINISTRADORES (Apenas SUPER_ADMIN)
router.get('/', [authMiddleware, authorizeRole(['SUPER_ADMIN'])], (req, res) => {
    const sql = `SELECT id, nome, email, role FROM administradores`;
    db.all(sql, [], (err, admins) => {
        if (err) return res.status(500).json({ error: 'Erro ao buscar administradores.' });
        res.status(200).json(admins);
    });
});

// ROTA PARA BUSCAR UM ADMIN ESPECÍFICO POR ID (Apenas SUPER_ADMIN)
router.get('/:id', [authMiddleware, authorizeRole(['SUPER_ADMIN'])], (req, res) => {
    const sql = `SELECT id, nome, email, role FROM administradores WHERE id = ?`;
    db.get(sql, [req.params.id], (err, admin) => {
        if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
        if (!admin) return res.status(404).json({ error: 'Administrador não encontrado.' });
        res.status(200).json(admin);
    });
});

// --- ROTA DE CRIAR ADMINISTRADOR CORRIGIDA ---
router.post('/', [authMiddleware, authorizeRole(['SUPER_ADMIN'])], (req, res) => {
    const { nome, email, role } = req.body;
    if (!nome || !email || !role) return res.status(400).json({ error: 'Nome, email e nível são obrigatórios.' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Nível de acesso inválido.' });

    // MUDANÇA 1: Adicionamos a coluna 'senha' no INSERT
    const sql = `INSERT INTO administradores (nome, email, role, senha) VALUES (?, ?, ?, ?)`;
    
    // MUDANÇA 2: Adicionamos um valor temporário para a senha
    const senhaTemporaria = 'AGUARDANDO_DEFINICAO';

    db.run(sql, [nome, email, role, senhaTemporaria], async function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
            }
            // Este log nos ajudará a ver o erro real no terminal se algo mais der errado
            console.error("Erro ao inserir admin no DB:", err); 
            return res.status(500).json({ error: 'Erro ao cadastrar novo administrador.' });
        }
        
        const adminId = this.lastID;
        const token = jwt.sign({ id: adminId, email: email, type: 'primeiro-acesso-admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        
        try {
            await enviarEmailPrimeiroAcesso(email, token);
            res.status(201).json({ message: 'Administrador criado com sucesso! Um e-mail foi enviado para ele definir a senha.' });
        } catch (emailError) {
            console.error('API: Erro ao enviar email, mas o usuário foi criado.', emailError);
            res.status(207).json({ message: 'Administrador criado, mas houve uma falha ao enviar o e-mail de configuração de senha.' });
        }
    });
});


// ROTA PARA ATUALIZAR UM ADMIN (Apenas SUPER_ADMIN)
router.put('/:id', [authMiddleware, authorizeRole(['SUPER_ADMIN'])], (req, res) => {
    const { nome, email, role } = req.body;
    if (!nome || !email || !role) return res.status(400).json({ error: 'Nome, email e nível são obrigatórios.' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Nível de acesso inválido.' });

    const sql = `UPDATE administradores SET nome = ?, email = ?, role = ? WHERE id = ?`;
    db.run(sql, [nome, email, role, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao atualizar administrador.' });
        if (this.changes === 0) return res.status(404).json({ error: 'Administrador não encontrado.' });
        res.status(200).json({ message: 'Administrador atualizado com sucesso!' });
    });
});

// ROTA PARA REMOVER UM ADMIN (Apenas SUPER_ADMIN)
router.delete('/:id', [authMiddleware, authorizeRole(['SUPER_ADMIN'])], (req, res) => {
    const adminIdParaRemover = req.params.id;
    const adminLogadoId = req.user.id;

    if (Number(adminIdParaRemover) === Number(adminLogadoId)) {
        return res.status(403).json({ error: 'Você não pode remover sua própria conta.' });
    }

    const sql = `DELETE FROM administradores WHERE id = ?`;
    db.run(sql, [adminIdParaRemover], function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao remover administrador.' });
        if (this.changes === 0) return res.status(404).json({ error: 'Administrador não encontrado.' });
        res.status(200).json({ message: 'Administrador removido com sucesso!' });
    });
});

module.exports = router;
