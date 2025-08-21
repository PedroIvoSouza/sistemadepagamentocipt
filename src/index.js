//Em: src/index.js

require('dotenv').config();

console.log('[BOT] BOT_SHARED_KEY len =', (process.env.BOT_SHARED_KEY||'').length);

const express = require('express');
const cors = require('cors');
const path = require('path');
const { scheduleConciliacao } = require('../cron/conciliarPagamentos');
const db = require('./database/db');
scheduleConciliacao();


// --- Importação das Rotas ---
const authRoutes                  = require('./api/authRoutes');
const userRoutes                  = require('./api/userRoutes');
const darsRoutes                  = require('./api/darsRoutes');
const adminAuthRoutes             = require('./api/adminAuthRoutes');
const adminRoutes                 = require('./api/adminRoutes');
const adminManagementRoutes       = require('./api/adminManagementRoutes');
const adminDarsRoutes             = require('./api/adminDarsRoutes');
const adminOficiosRoutes          = require('./api/adminOficiosRoutes');
const permissionariosRoutes       = require('./api/permissionariosRoutes');
const botRoutes                   = require('./api/botRoutes');


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
const documentosRoutes           = require('./api/documentosRoutes');

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
app.use('/api/permissionarios',   permissionariosRoutes);

// Administração Geral
app.use('/api/admin/auth',        adminAuthRoutes);
app.use('/api/admin/dars',        adminDarsRoutes);
app.use('/api/admins',            adminManagementRoutes);
app.use('/api/admin',             adminRoutes); // Rota para permissionários no painel admin
app.use('/api/admin',             adminOficiosRoutes); 


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
app.use('/api/documentos',       documentosRoutes);

app.use('/api/bot', botRoutes);



// Catch-all para servir a página de login do admin quando uma rota /admin/... não for encontrada
app.use('/admin', (req, res) => {
  res.sendFile(path.join(publicPath, 'admin', 'login.html'));
});

// Conexão com o Banco de Dados (SQLite)
ensureClientesEventosColumns(db);
ensureEventosColumns(db);

// Função para garantir colunas que seu update precisa
function ensureClientesEventosColumns(db){
  db.all(`PRAGMA table_info(Clientes_Eventos)`, [], (err, cols)=>{
    if (err) { console.error('[DB] PRAGMA table_info falhou:', err.message); return; }
    const names = new Set((cols||[]).map(c=> c.name.toLowerCase()));

    const adds = [];
    if (!names.has('cep'))         adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN cep TEXT`);
    if (!names.has('logradouro'))  adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN logradouro TEXT`);
    if (!names.has('numero'))      adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN numero TEXT`);
    if (!names.has('complemento')) adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN complemento TEXT`);
    if (!names.has('bairro'))      adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN bairro TEXT`);
    if (!names.has('cidade'))      adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN cidade TEXT`);
    if (!names.has('uf'))          adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN uf TEXT`);
    if (!names.has('endereco'))    adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN endereco TEXT`);

    (function runNext(i=0){
      if (i>=adds.length) { console.log('[DB] Clientes_Eventos OK.'); return; }
      db.run(adds[i], [], (e)=>{
        if (e) console.warn('[DB] Migração ignorada/erro:', adds[i], '-', e.message);
        runNext(i+1);
      });
    })();
  });
}
function ensureEventosColumns(db){
  db.all(`PRAGMA table_info(Eventos)`, [], (err, cols)=>{
    if (err) { console.error('[DB] PRAGMA table_info Eventos falhou:', err.message); return; }
    const names = new Set((cols||[]).map(c=> c.name.toLowerCase()));
    if (!names.has('data_vigencia_final')) {
      db.run(`ALTER TABLE Eventos ADD COLUMN data_vigencia_final TEXT`, [], e=>{
        if (e) console.warn('[DB] Migração ignorada/erro:', e.message);
        else console.log('[DB] Eventos.data_vigencia_final adicionada.');
      });
    }
  });
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
