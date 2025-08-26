const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

// garante a coluna telefone_cobranca
const dbAll = (sql, params=[]) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});
const dbRun = (sql, params=[]) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err){ err ? reject(err) : resolve(this); });
});
async function ensureColumn(table, column, type) {
  try {
    const rows = await dbAll(`PRAGMA table_info(${table})`);
    if (!rows.some(r => r.name === column)) {
      await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`[DB] ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch (e) {
    console.warn(`[DB] ensureColumn falhou ${table}.${column}:`, e.message || e);
  }
}
ensureColumn('permissionarios', 'telefone_cobranca', 'TEXT').catch(()=>{});

// Rota GET /me (agora busca também o email_notificacao)
router.get('/me', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const sql = `SELECT id, nome_empresa, cnpj, email, telefone, telefone_cobranca, email_financeiro, responsavel_financeiro, website, email_notificacao, numero_sala, valor_aluguel FROM permissionarios WHERE id = ?`;
    db.get(sql, [userId], (err, user) => {
        if (err) { return res.status(500).json({ error: 'Erro de banco de dados.' }); }
        if (!user) { return res.status(404).json({ error: 'Usuário não encontrado.' }); }
        res.status(200).json(user);
    });
});

// Rota PUT /me (agora salva também o email_notificacao)
router.put('/me', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const { telefone, telefone_cobranca, email_financeiro, responsavel_financeiro, website, email_notificacao } = req.body;
    const sql = `UPDATE permissionarios SET telefone = ?, telefone_cobranca = ?, email_financeiro = ?, responsavel_financeiro = ?, website = ?, email_notificacao = ? WHERE id = ?`;
    const params = [telefone, telefone_cobranca, email_financeiro, responsavel_financeiro, website, email_notificacao, userId];
    db.run(sql, params, function(err) {
        if (err) {
            return res.status(500).json({ error: 'Não foi possível atualizar os dados no banco.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Nenhum usuário foi encontrado para atualizar.' });
        }
        res.status(200).json({ message: 'Perfil atualizado com sucesso!' });
    });
});

// --- ROTA QUE FALTAVA ADICIONADA AQUI ---
// Rota para buscar as estatísticas do dashboard do permissionário
router.get('/dashboard-stats', authMiddleware, async (req, res) => {
    const userId = req.user.id;

    const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });

    try {
        const pendentes = await dbGetAsync(`SELECT COUNT(*) as count FROM dars WHERE permissionario_id = ? AND status = 'Pendente'`, [userId]);
        const vencidos = await dbGetAsync(`SELECT COUNT(*) as count FROM dars WHERE permissionario_id = ? AND status IN ('Vencido','Vencida')`, [userId]);
        const totalDevido = await dbGetAsync(`SELECT SUM(valor) as total FROM dars WHERE permissionario_id = ? AND status IN ('Pendente','Vencido','Vencida')`, [userId]);

        res.status(200).json({
            darsPendentes: pendentes.count || 0,
            darsVencidos: vencidos.count || 0,
            valorTotalDevido: (totalDevido.total || 0).toFixed(2)
        });
    } catch (error) {
        console.error("Erro ao buscar estatísticas do usuário:", error);
        res.status(500).json({ error: "Erro ao buscar estatísticas do dashboard." });
    }
});

// Rota para ALTERAR A SENHA
router.post('/change-password', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const { senha_atual, nova_senha, confirmar_nova_senha } = req.body;

    if (!senha_atual || !nova_senha || !confirmar_nova_senha) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }
    if (nova_senha !== confirmar_nova_senha) {
        return res.status(400).json({ error: 'A nova senha e a confirmação não coincidem.' });
    }
    if (nova_senha.length < 8) {
        return res.status(400).json({ error: 'A nova senha deve ter no mínimo 8 caracteres.' });
    }

    const sql = `SELECT senha FROM permissionarios WHERE id = ?`;
    db.get(sql, [userId], async (err, user) => {
        if (err) { return res.status(500).json({ error: 'Erro de banco de dados.' }); }
        if (!user) { return res.status(404).json({ error: 'Usuário não encontrado.' }); }

        const passwordMatch = await bcrypt.compare(senha_atual, user.senha);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'A senha atual está incorreta.' });
        }

        const hashedPassword = await bcrypt.hash(nova_senha, 10);
        const updateSql = `UPDATE permissionarios SET senha = ? WHERE id = ?`;
        db.run(updateSql, [hashedPassword, userId], (err) => {
            if (err) { return res.status(500).json({ error: 'Não foi possível atualizar a senha.' }); }
            res.status(200).json({ message: 'Senha alterada com sucesso!' });
        });
    });
});

module.exports = router;
