require('dotenv').config();

// ADICIONE ESTA LINHA PARA IGNORAR ERROS DE CERTIFICADO EM AMBIENTE DE TESTE
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
// ... resto do seu arquivo ...

// Importa as nossas novas rotas de autenticação
const authRoutes = require('./api/authRoutes');
const userRoutes = require('./api/userRoutes'); 
const darsRoutes = require('./api/darsRoutes'); 
const adminAuthRoutes = require('./api/adminAuthRoutes'); // <-- ADICIONE ESTA LINHA
const adminRoutes = require('./api/adminRoutes'); // <-- ADICIONE ESTA LINHA
const adminManagementRoutes = require('./api/adminManagementRoutes');
const adminDarsRoutes = require('./api/adminDarsRoutes');

const app = express();
const PORT = 3000;

app.use(express.json());

// --- CORREÇÃO PRINCIPAL AQUI ---
// 2. Usamos path.join para criar um caminho absoluto para a pasta 'public'
// __dirname é o diretório do arquivo atual (src)
// '..' sobe um nível (para a raiz do projeto)
// 'public' entra na pasta public
const publicPath = path.join(__dirname, '..', 'public');
console.log(`Servindo arquivos estáticos da pasta: ${publicPath}`); // Log para depuração
app.use(express.static(publicPath));
// --------------------------------

// Conecta ao banco de dados
const db = new sqlite3.Database('./sistemacipt.db');

app.get('/api', (req, res) => { // Mudei a rota raiz para /api para não conflitar
  res.send('API do Sistema de Pagamento CIPT no ar!');
});

// Diz ao app para usar as rotas de autenticação
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/dars', darsRoutes); 

// --- ROTAS DE ADMIN ---
// As mais específicas devem vir primeiro:
app.use('/api/admin/auth', adminAuthRoutes); 
app.use('/api/admin/dars', adminDarsRoutes); // <-- ESTA SOBE
app.use('/api/admins', adminManagementRoutes);

// A rota mais genérica de admin vem por ÚLTIMO:
app.use('/api/admin', adminRoutes); 
// --------------------

// Inicia o agendador de tarefas mensais
require('../cron/gerarDarsMensais.js');

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
});