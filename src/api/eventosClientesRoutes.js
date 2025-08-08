// Em: src/api/eventosClientesRoutes.js
// VERSÃO COMPLETA E CORRIGIDA

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { enviarEmailDefinirSenha } = require('../services/emailService');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const authMiddleware = require('../middleware/authMiddleware'); // Middleware de autenticação de cliente
const authorizeRole = require('../middleware/roleMiddleware'); // Middleware de autorização de papel

const adminRouter = express.Router();
const publicRouter = express.Router();
const clientRouter = express.Router(); // Router para clientes logados

const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

const SALT_ROUNDS = 10;

// ===================================================================
// ROTAS DO CLIENTE LOGADO (PORTAL DE EVENTOS)
// Todas as rotas aqui exigem um token de 'CLIENTE_EVENTO' válido
// ===================================================================
clientRouter.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO']));

/**
 * ROTA UNIFICADA [GET /me]
 * Retorna todos os dados associados ao cliente logado de uma só vez:
 * - Dados do perfil (user)
 * - Lista de eventos (eventos)
 * - Lista de DARs de eventos (dars)
 * Isso otimiza o carregamento das páginas do portal do cliente.
 */
clientRouter.get('/me', async (req, res) => {
    const clienteId = req.user.id;

    try {
        // Busca os dados em paralelo para mais eficiência
        const fetchUser = new Promise((resolve, reject) => {
            const sql = `SELECT * FROM Clientes_Eventos WHERE id = ?`;
            db.get(sql, [clienteId], (err, row) => err ? reject(err) : resolve(row));
        });

        const fetchEventos = new Promise((resolve, reject) => {
            const sql = `SELECT * FROM Eventos WHERE id_cliente = ? ORDER BY id DESC`;
            db.all(sql, [clienteId], (err, rows) => err ? reject(err) : resolve(rows));
        });

        const fetchDars = new Promise((resolve, reject) => {
            const sql = `
                SELECT d.*, de.id_evento, de.numero_parcela, de.valor_parcela
                FROM dars d
                JOIN DARs_Eventos de ON de.id_dar = d.id
                JOIN Eventos e ON e.id = de.id_evento
                WHERE e.id_cliente = ?
                ORDER BY d.data_vencimento DESC, d.id DESC
            `;
            db.all(sql, [clienteId], (err, rows) => err ? reject(err) : resolve(rows));
        });

        const [user, eventos, dars] = await Promise.all([fetchUser, fetchEventos, fetchDars]);

        if (!user) {
            return res.status(404).json({ error: 'Cliente não encontrado.' });
        }
        
        // Remove dados sensíveis antes de enviar
        delete user.senha_hash;
        delete user.token_definir_senha;

        res.json({ user, eventos, dars });

    } catch (err) {
        console.error('[ERRO] Ao buscar dados completos do cliente de evento:', err.message);
        return res.status(500).json({ error: 'Erro interno ao buscar os dados do cliente.' });
    }
});


/**
 * ROTA DE ATUALIZAÇÃO DE PERFIL [PUT /me]
 * Permite que o cliente atualize seus próprios dados de contato e endereço.
 */
clientRouter.put('/me', (req, res) => {
    const clienteId = req.user.id;
    const {
        telefone, nomeResponsavel, cep, logradouro, numero, bairro, cidade, uf
    } = req.body;

    const enderecoCompleto = `${logradouro || ''}, ${numero || ''} - ${bairro || ''}, ${cidade || ''} - ${uf || ''}, ${cep || ''}`;

    const sql = `
        UPDATE Clientes_Eventos SET
            telefone = ?, nome_responsavel = ?, cep = ?, logradouro = ?, 
            numero = ?, bairro = ?, cidade = ?, uf = ?, endereco = ?
        WHERE id = ?
    `;
    const params = [telefone, nomeResponsavel, cep, logradouro, numero, bairro, cidade, uf, enderecoCompleto, clienteId];

    db.run(sql, params, function(err) {
        if (err) {
            console.error('[ERRO] Ao atualizar perfil do cliente de evento:', err.message);
            return res.status(500).json({ error: 'Erro ao atualizar os dados no banco de dados.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        res.json({ message: 'Perfil atualizado com sucesso!' });
    });
});

/**
 * ROTA DE MUDANÇA DE SENHA [POST /change-password]
 * Permite que o cliente logado altere sua senha de acesso.
 */
clientRouter.post('/change-password', (req, res) => {
    const clienteId = req.user.id;
    const { senha_atual, nova_senha, confirmar_nova_senha } = req.body;

    if (!senha_atual || !nova_senha || !confirmar_nova_senha) {
        return res.status(400).json({ error: 'Todos os campos de senha são obrigatórios.' });
    }
    if (nova_senha !== confirmar_nova_senha) {
        return res.status(400).json({ error: 'As novas senhas não coincidem.' });
    }

    db.get(`SELECT senha_hash FROM Clientes_Eventos WHERE id = ?`, [clienteId], async (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const match = await bcrypt.compare(senha_atual, user.senha_hash);
        if (!match) {
            return res.status(401).json({ error: 'A senha atual está incorreta.' });
        }

        const novaSenhaHash = await bcrypt.hash(nova_senha, SALT_ROUNDS);
        db.run(`UPDATE Clientes_Eventos SET senha_hash = ? WHERE id = ?`, [novaSenhaHash, clienteId], (err) => {
            if (err) {
                console.error('[ERRO] Ao alterar senha do cliente de evento:', err.message);
                return res.status(500).json({ error: 'Erro ao atualizar a senha no banco de dados.' });
            }
            res.json({ message: 'Senha alterada com sucesso!' });
        });
    });
});


// ===================================================================
// ROTAS PÚBLICAS (Acesso sem token para Login, Definição de Senha)
// ===================================================================

// Rota para o cliente DEFINIR a senha pela primeira vez
publicRouter.post('/definir-senha', async (req, res) => {
    const { token, senha } = req.body;
    if (!token || !senha) {
        return res.status(400).json({ error: 'Token e senha são obrigatórios.' });
    }

    const sql = `SELECT * FROM Clientes_Eventos WHERE token_definir_senha = ?`;
    db.get(sql, [token], async (err, cliente) => {
        if (err) return res.status(500).json({ error: 'Erro interno no servidor.' });
        if (!cliente) return res.status(404).json({ error: 'Token inválido ou já utilizado.' });

        try {
            const senha_hash = await bcrypt.hash(senha, SALT_ROUNDS);
            const updateSql = `UPDATE Clientes_Eventos SET senha_hash = ?, token_definir_senha = NULL WHERE id = ?`;
            db.run(updateSql, [senha_hash, cliente.id], function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Não foi possível atualizar a senha.' });
                }
                res.json({ message: 'Senha definida com sucesso!' });
            });
        } catch (hashError) {
            res.status(500).json({ error: 'Erro interno no servidor ao processar senha.' });
        }
    });
});

// Validação do token antes de exibir a página de definir senha
publicRouter.get('/definir-senha/validar', (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).json({ ok: false, error: 'Token ausente.' });
    }

    const sql = `SELECT id, nome_razao_social FROM Clientes_Eventos WHERE token_definir_senha = ?`;
    db.get(sql, [token], (err, row) => {
        if (err) {
            console.error('Erro ao validar token:', err);
            return res.status(500).json({ ok: false, error: 'Erro interno.' });
        }
        if (!row) {
            return res.status(404).json({ ok: false, error: 'Token inválido ou já utilizado.' });
        }
        res.json({ ok: true, cliente: { id: row.id, nome: row.nome_razao_social } });
    });
});

// Login do cliente de eventos
publicRouter.post('/login', (req, res) => {
    const { login, senha } = req.body;
    if (!login || !senha) {
        return res.status(400).json({ error: 'Login e senha são obrigatórios.' });
    }

    const sql = `SELECT id, nome_razao_social, email, senha_hash FROM Clientes_Eventos WHERE email = ? OR documento = ?`;
    db.get(sql, [login, login], async (err, row) => {
        if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
        if (!row || !row.senha_hash) {
            return res.status(401).json({ error: 'Credenciais inválidas ou cadastro não finalizado.' });
        }

        const ok = await bcrypt.compare(senha, row.senha_hash);
        if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

        const payload = {
            id: row.id,
            nome: row.nome_razao_social,
            role: 'CLIENTE_EVENTO'
        };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.json({ message: 'Login realizado com sucesso!', token });
    });
});


// ===================================================================
// ROTAS DE ADMIN (Gerenciamento de Clientes de Eventos)
// Todas as rotas aqui exigem um token de 'ADMIN' válido
// ===================================================================
adminRouter.use(adminAuthMiddleware);

// Rota para LISTAR todos os clientes de eventos
adminRouter.get('/', (req, res) => {
    const sql = `SELECT * FROM Clientes_Eventos ORDER BY nome_razao_social`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("Erro ao buscar clientes de eventos:", err.message);
            return res.status(500).json({ error: 'Erro interno no servidor.' });
        }
        res.json(rows);
    });
});

// Rota para CRIAR um novo cliente de evento
adminRouter.post('/', async (req, res) => {
    const { 
        nome_razao_social, tipo_pessoa, documento, email, telefone, 
        nome_responsavel, tipo_cliente, documento_responsavel,
        cep, logradouro, numero, complemento, bairro, cidade, uf
    } = req.body;

    if (!nome_razao_social || !tipo_pessoa || !documento || !email || !tipo_cliente) {
        return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
    }

    try {
        const token = crypto.randomBytes(32).toString('hex');
        const enderecoCompleto = `${logradouro || ''}, ${numero || ''} ${complemento || ''} - ${bairro || ''}, ${cidade || ''} - ${uf || ''}, ${cep || ''}`;

        const sql = `INSERT INTO Clientes_Eventos (
            nome_razao_social, tipo_pessoa, documento, email, telefone, 
            nome_responsavel, tipo_cliente, token_definir_senha, documento_responsavel,
            cep, logradouro, numero, complemento, bairro, cidade, uf, endereco
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const params = [
            nome_razao_social, tipo_pessoa, documento, email, telefone, 
            nome_responsavel, tipo_cliente, token, documento_responsavel,
            cep, logradouro, numero, complemento, bairro, cidade, uf, enderecoCompleto
        ];

        db.run(sql, params, async function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ error: 'Já existe um cliente com este CPF/CNPJ ou E-mail.' });
                }
                console.error("Erro ao criar cliente de evento:", err.message);
                return res.status(500).json({ error: 'Erro ao salvar o cliente no banco de dados.' });
            }

            try {
                await enviarEmailDefinirSenha(email, nome_razao_social, token);
                res.status(201).json({ id: this.lastID, message: 'Cliente criado com sucesso. E-mail para definição de senha foi enviado.' });
            } catch (emailError) {
                console.error("ERRO GRAVE: Cliente criado, mas o e-mail de senha falhou:", emailError);
                res.status(201).json({ id: this.lastID, message: 'Cliente criado, mas houve uma falha ao enviar o e-mail de definição de senha.' });
            }
        });
    } catch (error) {
        console.error("Erro no processo de criação de cliente:", error);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// Rota para ATUALIZAR um cliente de evento (pelo admin)
adminRouter.put('/:id', (req, res) => {
    const { id } = req.params;
    const { 
        nome_razao_social, tipo_pessoa, documento, email, telefone, 
        nome_responsavel, tipo_cliente, documento_responsavel,
        cep, logradouro, numero, complemento, bairro, cidade, uf
    } = req.body;

    if (!nome_razao_social || !tipo_pessoa || !documento || !email || !tipo_cliente) {
        return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
    }

    const enderecoCompleto = `${logradouro || ''}, ${numero || ''} ${complemento || ''} - ${bairro || ''}, ${cidade || ''} - ${uf || ''}, ${cep || ''}`;

    const sql = `UPDATE Clientes_Eventos SET 
        nome_razao_social = ?, tipo_pessoa = ?, documento = ?, email = ?, 
        telefone = ?, nome_responsavel = ?, tipo_cliente = ?, documento_responsavel = ?,
        cep = ?, logradouro = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, endereco = ?
        WHERE id = ?`;

    const params = [
        nome_razao_social, tipo_pessoa, documento, email, telefone, 
        nome_responsavel, tipo_cliente, documento_responsavel,
        cep, logradouro, numero, complemento, bairro, cidade, uf, enderecoCompleto, id
    ];

    db.run(sql, params, function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'Já existe um cliente com este CPF/CNPJ ou E-mail.' });
            }
            console.error("Erro ao atualizar cliente de evento:", err.message);
            return res.status(500).json({ error: 'Erro ao atualizar o cliente no banco de dados.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
        }
        res.json({ message: 'Cliente atualizado com sucesso.', id });
    });
});

// Rota para REENVIAR O E-MAIL DE DEFINIÇÃO DE SENHA (pelo admin)
adminRouter.post('/:id/reenviar-senha', async (req, res) => {
    const { id } = req.params;
    try {
        const cliente = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM Clientes_Eventos WHERE id = ?`, [id], (err, row) => {
                if (err) reject(new Error('Erro ao buscar cliente no banco de dados.'));
                else if (!row) reject(new Error('Cliente não encontrado.'));
                else resolve(row);
            });
        });

        const novoToken = crypto.randomBytes(32).toString('hex');
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE Clientes_Eventos SET token_definir_senha = ? WHERE id = ?`,
                [novoToken, id],
                function(err) {
                    if (err) reject(new Error('Erro ao atualizar o token do cliente.'));
                    else resolve();
                }
            );
        });

        await enviarEmailDefinirSenha(cliente.email, cliente.nome_razao_social, novoToken);
        res.json({ message: 'E-mail de definição de senha reenviado com sucesso!' });
    } catch (error) {
        console.error("Erro ao reenviar e-mail de senha:", error.message);
        res.status(500).json({ error: `Falha ao reenviar e-mail: ${error.message}` });
    }
});

// Rota para DELETAR um cliente de evento (pelo admin)
adminRouter.delete('/:id', (req, res) => {
    const { id } = req.params;
    // Adicionar verificação de dependências (eventos, dars) antes de deletar seria uma boa prática
    const sql = `DELETE FROM Clientes_Eventos WHERE id = ?`;
    db.run(sql, id, function(err) {
        if (err) {
            return res.status(500).json({ error: 'Erro ao deletar o cliente no banco de dados.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
        }
        res.status(200).json({ message: 'Cliente deletado com sucesso.' });
    });
});


// ===================================================================
// EXPORTAÇÃO DOS ROUTERS
// ===================================================================
module.exports = {
    adminRoutes: adminRouter,
    publicRoutes: publicRouter,
    clientRoutes: clientRouter
};