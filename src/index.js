const express = require('express');
const sqlite3 = require('sqlite3').verbose(); // Importe o sqlite3

const app = express();
const PORT = 3000;

// Middleware ESSENCIAL para o Express entender JSON no corpo das requisições
app.use(express.json());

// Conecta ao banco de dados
const db = new sqlite3.Database('./sistemacipt.db');

app.get('/', (req, res) => {
  res.send('API do Sistema de Pagamento CIPT no ar!');
});

// --- NOSSA NOVA ROTA DE CADASTRO ---
app.post('/api/permissionarios', (req, res) => {
    console.log('Recebendo dados para cadastro:', req.body);

    // Pega os dados do corpo da requisição
    const { nome_empresa, cnpj, email, valor_aluguel, senha } = req.body;

    // Validação básica
    if (!nome_empresa || !cnpj || !email || !valor_aluguel || !senha) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    const sql = `INSERT INTO permissionarios (nome_empresa, cnpj, email, valor_aluguel, senha) VALUES (?, ?, ?, ?, ?)`;

    db.run(sql, [nome_empresa, cnpj, email, valor_aluguel, senha], function(err) {
        if (err) {
            console.error('Erro no banco de dados:', err.message);
            // Verifica erro de CNPJ/email duplicado
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'CNPJ ou E-mail já cadastrado.' });
            }
            return res.status(500).json({ error: 'Erro ao cadastrar permissionário.' });
        }

        // Se tudo deu certo, retorna o ID do novo usuário
        res.status(201).json({
            message: 'Permissionário cadastrado com sucesso!',
            id: this.lastID
        });
    });
});
// ------------------------------------

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
});