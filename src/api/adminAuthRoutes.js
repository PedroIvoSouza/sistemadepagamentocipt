// Em: src/api/adminAuthRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// --- ROTA DE LOGIN DO ADMIN ---
router.post('/login', (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    // Busca o admin no banco, incluindo a sua 'role' (nível de permissão)
    const sql = `SELECT id, nome, senha, role FROM administradores WHERE email = ?`;
    
    db.get(sql, [email], async (err, admin) => {
        if (err) { return res.status(500).json({ error: 'Erro de banco de dados.' }); }
        if (!admin) { return res.status(401).json({ error: 'Credenciais inválidas.' }); }

        const senhaValida = await bcrypt.compare(senha, admin.senha);
        if (!senhaValida) { return res.status(401).json({ error: 'Credenciais inválidas.' }); }

        // Gera o token incluindo a 'role' no payload (a informação que faltava)
        const payload = { 
            id: admin.id, 
            nome: admin.nome, 
            role: admin.role 
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

        res.status(200).json({ 
            message: 'Login de administrador bem-sucedido!',
            token: token 
        });
    });
});


// --- ROTA PARA DEFINIR A SENHA (PRIMEIRO ACESSO DO ADMIN) ---
router.post('/definir-senha', async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres.' });
    }

    try {
        // Verifica se o token é válido e foi assinado por nós
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Verificação extra para garantir que é um token do tipo certo
        if (decoded.type !== 'primeiro-acesso-admin') {
            return res.status(401).json({ error: 'Tipo de token inválido.' });
        }

        const adminId = decoded.id;
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `UPDATE administradores SET senha = ? WHERE id = ?`;
        db.run(sql, [hashedPassword, adminId], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Erro ao atualizar a senha no banco de dados.' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Administrador não encontrado.' });
            }
            res.status(200).json({ message: 'Senha definida com sucesso! Você já pode fazer o login.' });
        });

    } catch (error) {
        // Se o token for inválido, expirado, ou malicioso, o jwt.verify vai gerar um erro
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
});

Com certeza. Vamos criar as duas páginas que faltam para o fluxo de gerenciamento de senha do administrador.

O processo envolve criar os arquivos HTML no frontend e as rotas correspondentes na API do backend para lidar com a lógica de forma segura.

Parte 1: Página "Solicitar Redefinição de Senha"
Esta é a tela onde um administrador que esqueceu a senha digita seu e-mail para receber o link de redefinição.

1.1 - A Lógica no Backend (adminAuthRoutes.js)
Primeiro, vamos adicionar a rota na API que recebe o e-mail, gera um token de redefinição e envia o link.

Abra o arquivo src/api/adminAuthRoutes.js.

Substitua o conteúdo dele pela versão completa abaixo. Eu adicionei a nova rota solicitar-redefinicao e atualizei a rota definir-senha para aceitar também tokens de redefinição.

JavaScript

// Em: src/api/adminAuthRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
// Vamos precisar do serviço de e-mail aqui
const { enviarEmailPrimeiroAcesso } = require('../services/emailService'); 

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// Rota de Login (sem alterações)
router.post('/login', (req, res) => { /* ... seu código de login ... */ });

// --- NOVA ROTA ADICIONADA ---
// Rota para solicitar a redefinição de senha
router.post('/solicitar-redefinicao', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'O e-mail é obrigatório.' });

    const sql = `SELECT * FROM administradores WHERE email = ?`;
    db.get(sql, [email], (err, admin) => {
        if (err || !admin) {
            // Por segurança, não informamos se o e-mail foi encontrado ou não.
            return res.status(200).json({ message: 'Se um usuário com este e-mail existir, um link de redefinição será enviado.' });
        }

        // Gera um token de curta duração (15 minutos) específico para redefinição
        const payload = { id: admin.id, type: 'redefinicao-senha-admin' };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });

        // A função de enviar e-mail de primeiro acesso serve perfeitamente, pois envia um link com token
        enviarEmailPrimeiroAcesso(admin.email, token)
            .then(() => {
                res.status(200).json({ message: 'Se um usuário com este e-mail existir, um link de redefinição será enviado.' });
            })
            .catch(error => {
                console.error("Erro ao enviar e-mail de redefinição:", error);
                res.status(500).json({ error: 'Erro ao enviar e-mail de redefinição.' });
            });
    });
});

// Rota para definir a senha (atualizada para aceitar os dois tipos de token)
router.post('/definir-senha', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
    if (password.length < 8) return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres.' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Agora aceita tanto o token de primeiro acesso quanto o de redefinição
        if (decoded.type !== 'primeiro-acesso-admin' && decoded.type !== 'redefinicao-senha-admin') {
            return res.status(401).json({ error: 'Tipo de token inválido.' });
        }

        const adminId = decoded.id;
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `UPDATE administradores SET senha = ? WHERE id = ?`;
        db.run(sql, [hashedPassword, adminId], function (err) {
            if (err) return res.status(500).json({ error: 'Erro ao atualizar a senha.' });
            res.status(200).json({ message: 'Senha definida com sucesso! Você já pode fazer o login.' });
        });
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
});

module.exports = router;
