require('dotenv').config();

// PROBLEMA #1 REMOVIDO: A linha insegura 'NODE_TLS_REJECT_UNAUTHORIZED' foi deletada.

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Importa as rotas
const authRoutes = require('./api/authRoutes');
const userRoutes = require('./api/userRoutes');
const darsRoutes = require('./api/darsRoutes');
const adminAuthRoutes = require('./api/adminAuthRoutes');
const adminRoutes = require('./api/adminRoutes');
const adminManagementRoutes = require('./api/adminManagementRoutes');
const adminDarsRoutes = require('./api/adminDarsRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para JSON
app.use(express.json());

// Servir arquivos estáticos da pasta 'public'
const publicPath = path.join(__dirname, '..', 'public');
console.log(`Servindo arquivos estáticos da pasta: ${publicPath}`);
app.use(express.static(publicPath));

// --- CORREÇÃO #2: Conexão com o Banco de Dados mais segura ---
// Envolvemos a conexão em um 'try...catch' para capturar qualquer erro de inicialização.
let db;
try {
  db = new sqlite3.Database('./sistemacipt.db', (err) => {
    if (err) {
      // Se houver um erro ao conectar, vamos logá-lo claramente e encerrar o processo.
      console.error('[ERRO DE BANCO DE DADOS] Não foi possível conectar ao SQLite:', err.message);
      process.exit(1); // Encerra a aplicação com um código de erro
    }
    console.log('[INFO] Conectado ao banco de dados SQLite com sucesso.');
  });
} catch (error) {
  console.error('[ERRO FATAL] Falha ao instanciar o banco de dados:', error.message);
  process.exit(1);
}
// ----------------------------------------------------------------

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/dars', darsRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/dars', adminDarsRoutes);
app.use('/api/admins', adminManagementRoutes);
app.use('/api/admin', adminRoutes);

// Inicia o servidor e, SÓ DEPOIS, o agendador de tarefas
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);

  // --- CORREÇÃO #3: Iniciar o "robô" apenas depois que o servidor estiver no ar ---
  // Isso evita que um erro no cron job impeça o servidor de iniciar.
  try {
    require('../cron/gerarDarsMensais.js');
    console.log('[INFO] Agendador de tarefas (cron) iniciado com sucesso.');
  } catch (error) {
    console.error('[ERRO DE CRON] Falha ao iniciar o agendador de tarefas:', error.message);
  }
  // ---------------------------------------------------------------------------------
});

// Listener para erros inesperados no servidor
server.on('error', (error) => {
  console.error('[ERRO DE SERVIDOR] Ocorreu um erro:', error);
});
