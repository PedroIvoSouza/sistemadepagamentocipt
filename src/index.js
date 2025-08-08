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

// CORREÇÃO: Desestruturando os routers de eventos
const {
  adminRoutes:  eventosClientesAdminRoutes,
  publicRoutes: eventosClientesPublicRoutes,
  clientRoutes: eventosClientesClientRoutes 
} = require('./api/eventosClientesRoutes');

const eventosRoutes               = require('./api/eventosRoutes');
// -----------------------------

// NOVA LINHA: Importe o novo arquivo de rotas de eventos para admin
const adminEventosRoutes = require('./api/adminEventosRoutes');

const app  = express();
app.use(cors({
  origin: '*', // ⚠️ permite tudo. Para produção, restrinja isso.
  credentials: true
}));
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Servir arquivos estáticos da pasta 'public'
const publicPath = path.join(__dirname, '..', 'public');
console.log(`Servindo arquivos estáticos da pasta: ${publicPath}`);
app.use('/', express.static(publicPath));

// --- Uso das Rotas da API ---
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

// --- CORREÇÃO APLICADA AQUI ---
// Cada router de eventos agora tem um prefixo de URL único.

// 1. Rotas PÚBLICAS para clientes de eventos (login, definir senha)
app.use('/api/eventos/clientes', eventosClientesPublicRoutes);

// 2. Rotas do PORTAL DO CLIENTE de eventos (para o cliente quando ele está logado)
app.use('/api/portal/eventos', eventosClientesClientRoutes);

// 3. Rotas de ADMINISTRAÇÃO de clientes de eventos (usadas no seu painel de gestão)
app.use('/api/admin/eventos-clientes', eventosClientesAdminRoutes);

// NOVA LINHA: Adicione esta linha para registrar as novas rotas de eventos para admin
app.use('/api/admin/eventos', adminEventosRoutes);
// ------------------------------------

// Eventos (gerenciamento geral de eventos)
app.use('/api/eventos',           eventosRoutes);



// Catch-all para servir a página de login do admin quando uma rota /admin/... não for encontrada
app.use('/admin', (req, res) => {
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