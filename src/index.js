//Em: src/index.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// --- Importação das Rotas ---
const authRoutes                  = require('./api/authRoutes');
const userRoutes                  = require('./api/userRoutes');
const darsRoutes                  = require('./api/darsRoutes');
const adminAuthRoutes             = require('./api/adminAuthRoutes');
const adminRoutes                 = require('./api/adminRoutes');
const adminManagementRoutes       = require('./api/adminManagementRoutes');
const adminDarsRoutes             = require('./api/adminDarsRoutes');
const {
  adminRoutes:  eventosClientesAdminRoutes,
  publicRoutes: eventosClientesPublicRoutes,
  clientRoutes: eventosClientesClientRoutes 
} = require('./api/eventosClientesRoutes');
const adminEventosRoutes          = require('./api/adminEventosRoutes');
// -----------------------------

const app  = express();
app.use(cors({
  origin: '*', // ⚠️ permite tudo. Para produção, restrinja isso.
  credentials: true
}));
const PORT = process.env.PORT || 3000;

// 1. PRIMEIRO: Middlewares para processar o corpo da requisição
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 2. SEGUNDO: Registro de TODAS as rotas da API
// Autenticação e usuário (Permissionários)
app.use('/api/auth',              authRoutes);
app.use('/api/user',              userRoutes);

// DARs para permissionários
app.use('/api/dars',              darsRoutes);

// Administração Geral
app.use('/api/admin/auth',        adminAuthRoutes);
app.use('/api/admin/dars',        adminDarsRoutes);
app.use('/api/admins',            adminManagementRoutes);
app.use('/api/admin',             adminRoutes); // Rota para permissionários no painel admin

// Rotas de Clientes de Eventos
app.use('/api/eventos/clientes',      eventosClientesPublicRoutes); // Públicas (login, etc)
app.use('/api/portal/eventos',        eventosClientesClientRoutes); // Portal do Cliente logado
app.use('/api/admin/eventos-clientes', eventosClientesAdminRoutes); // Admin para Clientes

// Rotas de Eventos (gerenciadas pelo Admin)
app.use('/api/admin/eventos',     adminEventosRoutes);

// 3. TERCEIRO: Servir arquivos estáticos da pasta 'public'
const publicPath = path.join(__dirname, '..', 'public');
console.log(`Servindo arquivos estáticos da pasta: ${publicPath}`);
app.use('/', express.static(publicPath));

// 4. QUARTO: Rota Catch-all para servir a página de login do admin se nenhuma rota anterior corresponder
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(publicPath, 'admin', 'login.html'));
});

// Conexão com o Banco de Dados (SQLite)
let db;
try {
  db = new sqlite3.Database('./sistemacipt.db', err => {
    if (err) {
      console.error('[ERRO DE BANCO DE DADOS] Não foi possível conectar ao SQLite:', err.message);
      process.exit(1);
    }
    console.log('[INFO] Conectado ao banco de dados SQLite com sucesso.');
  });
} catch (error) {
  console.error('[ERRO FATAL] Falha ao instanciar o banco de dados:', error.message);
  process.exit(1);
}

// Inicia o servidor e o agendador de tarefas
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
  try {
    require('../cron/gerarDarsMensais.js');
    console.log('[INFO] Agendador de tarefas (cron) iniciado com sucesso.');
  } catch (error) {
    console.error('[ERRO DE CRON] Falha ao iniciar o agendador de tarefas:', error.message);
  }
});

server.on('error', error => {
  console.error('[ERRO DE SERVIDOR] Ocorreu um erro:', error);
});