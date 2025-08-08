require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// --- Importação das Rotas ---
const authRoutes         = require('./api/authRoutes');
const userRoutes         = require('./api/userRoutes');
const darsRoutes         = require('./api/darsRoutes');
const adminAuthRoutes    = require('./api/adminAuthRoutes');
const adminRoutes        = require('./api/adminRoutes');
const adminManagementRoutes = require('./api/adminManagementRoutes');
const adminDarsRoutes    = require('./api/adminDarsRoutes');
const eventosRoutes      = require('./api/eventosRoutes');
const adminEventosRoutes = require('./api/adminEventosRoutes');

const {
  adminRoutes:  eventosClientesAdminRoutes,
  publicRoutes: eventosClientesPublicRoutes,
  clientRoutes: eventosClientesClientRoutes
} = require('./api/eventosClientesRoutes');

const app = express();

// --- CORS ---
app.use(cors({
  origin: '*', // ⚠️ Em produção, restrinja ao domínio da aplicação
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Conexão com SQLite ---
const dbPath = path.resolve(__dirname, '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error('[ERRO DE BANCO] Não foi possível conectar ao SQLite:', err.message);
    process.exit(1);
  }
  console.log('[INFO] Conectado ao SQLite em', dbPath);
});
app.locals.db = db;

// --- Arquivos estáticos ---
const publicPath = path.resolve(__dirname, '..', 'public');
console.log('[INFO] Servindo estáticos em', publicPath);
app.use(express.static(publicPath));

// --- ROTAS DA API ---

// Permissionários
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/dars', darsRoutes);

// Administração geral
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/dars', adminDarsRoutes);
app.use('/api/admin/admins', adminManagementRoutes);
app.use('/api/admin', adminRoutes);

// Eventos — clientes e portal
app.use('/api/eventos/clientes', eventosClientesPublicRoutes);     // login, definir senha
app.use('/api/portal/eventos', eventosClientesClientRoutes);       // cliente autenticado
app.use('/api/admin/eventos-clientes', eventosClientesAdminRoutes); // admin gerencia clientes de evento
app.use('/api/eventos', eventosRoutes);
app.use('/api/admin/eventos', adminEventosRoutes);

// --- SPA: Redirecionamento para login.html do admin ---
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(publicPath, 'admin', 'login.html'));
});

// --- Inicialização do Servidor e Cron ---
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[INFO] Servidor rodando na porta ${PORT}`);

  try {
    require(path.resolve(__dirname, '..', 'cron', 'gerarDarsMensais.js'));
    console.log('[INFO] Agendador de tarefas iniciado');
  } catch (error) {
    console.error('[ERRO DE CRON] Falha ao iniciar cron:', error.message);
  }
});

server.on('error', err => {
  console.error('[ERRO DE SERVIDOR]', err);
});