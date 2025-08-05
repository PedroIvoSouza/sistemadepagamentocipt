const express = require('express');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { enviarEmailRedefinicao } = require('../services/emailService');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// Rota 1: Usuário solicita o código de verificação
router.post('/solicitar-acesso', (req, res) => {
    const { cnpj } = req.body;
    if (!cnpj) { return res.status(400).json({ error: 'O CNPJ é obrigatório.' }); }
    
    const sql = `SELECT * FROM permissionarios WHERE cnpj = ?`;
    db.get(sql, [cnpj], async (err, user) => {
        if (err) { return res.status(500).json({ error: 'Erro interno do servidor.' }); }
        if (!user) { return res.status(200).json({ message: 'Se um CNPJ correspondente for encontrado, um e-mail será enviado.' }); }

        const codigo = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 600000; // 10 minutos

        try {
            const hashedCodigo = await bcrypt.hash(codigo, 10);
            const updateSql = `UPDATE permissionarios SET senha_reset_token = ?, senha_reset_expires = ? WHERE id = ?`;
            db.run(updateSql, [hashedCodigo, expires, user.id], async function(err) {
                if (err) { return res.status(500).json({ error: 'Erro ao salvar o token de redefinição.' }); }
                
                await enviarEmailRedefinicao(user.email, codigo);
                res.status(200).json({ message: 'Se um CNPJ correspondente for encontrado, um e-mail será enviado.' });
            });
        } catch (error) {
            console.error('Erro no processo de redefinição:', error);
            return res.status(500).json({ error: 'Erro ao processar a solicitação.' });
        }
    });
});

// Rota 2: Usuário envia o código para verificação
router.post('/verificar-codigo', (req, res) => {
    const { cnpj, codigo } = req.body;
    if (!cnpj || !codigo) {
        return res.status(400).json({ error: 'CNPJ e código são obrigatórios.' });
    }

    const sql = `SELECT * FROM permissionarios WHERE cnpj = ? AND senha_reset_expires > ?`;
    db.get(sql, [cnpj, Date.now()], async (err, user) => {
        if (err) { return res.status(500).json({ error: 'Erro de banco de dados.' }); }
        if (!user) { return res.status(400).json({ error: 'Código inválido, expirado ou CNPJ incorreto. Tente novamente.' }); }

        const match = await bcrypt.compare(codigo, user.senha_reset_token);

        if (!match) {
            return res.status(400).json({ error: 'Código inválido, expirado ou CNPJ incorreto. Tente novamente.' });
        }

        const payload = { id: user.id, reset: true };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' }); // Permissão válida por 15 minutos

        res.status(200).json({
            message: 'Código verificado com sucesso!',
            token: token
        });
    });
});

// Rota 3: Usuário define a nova senha (usando o token de permissão)
router.post('/definir-senha', (req, res) => {
    const { token, password, passwordConfirmation } = req.body;

    if (!token || !password || !passwordConfirmation) {
        return res.status(400).json({ error: 'Token e senhas são obrigatórios.' });
    }
    if (password !== passwordConfirmation) {
        return res.status(400).json({ error: 'As senhas não coincidem.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Permissão inválida ou expirada. Por favor, reinicie o processo.' });
        }
        
        if (!decoded.reset) {
            return res.status(403).json({ error: 'Permissão inválida.' });
        }

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const userId = decoded.id;

            const updateSql = `UPDATE permissionarios SET senha = ?, senha_reset_token = NULL, senha_reset_expires = NULL WHERE id = ?`;
            db.run(updateSql, [hashedPassword, userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Não foi possível atualizar a senha.' });
                }
                res.status(200).json({ message: 'Senha atualizada com sucesso!' });
            });

        } catch (hashError) {
            res.status(500).json({ error: 'Erro de segurança ao processar a senha.' });
        }
    });
});

// Rota 4: Rota de Login normal
router.post('/login', (req, res) => {
    const { cnpj, password } = req.body;

    if (!cnpj || !password) {
        return res.status(400).json({ error: 'CNPJ e senha são obrigatórios.' });
    }

    const sql = `SELECT * FROM permissionarios WHERE cnpj = ?`;
    db.get(sql, [cnpj], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Erro de banco de dados.' });
        }
        if (!user) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        if (!user.senha) {
            return res.status(401).json({ error: 'Usuário não possui senha cadastrada. Por favor, use o "Primeiro Acesso".' });
        }

        const passwordMatch = await bcrypt.compare(password, user.senha);

        if (!passwordMatch) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        const payload = { id: user.id, nome: user.nome_empresa };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

        res.status(200).json({ 
            message: 'Login bem-sucedido!',
            token: token 
        });
    });
});

module.exports = router;