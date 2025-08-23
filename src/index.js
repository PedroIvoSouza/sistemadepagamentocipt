// src/index.js
require('dotenv').config();

console.log('[BOOT] BOT_SHARED_KEY len =', (process.env.BOT_SHARED_KEY || '').length);

const express = require('express');
const cors = require('cors');
const path = require('path');
const { scheduleConciliacao } = require('../cron/conciliarPagamentos');
const db = require('./database/db');

// ===== Helpers de boot =====
function assertRouter(name, r) {
  const ok = r && (typeof r === 'function' || typeof r.use === 'function');
  if (!ok) {
    console.error(`[BOOT][FATAL] "${name}" não é um express.Router. Valor:`, r);
    console.error('[BOOT][HINT] Verifique o module.exports do arquivo correspondente.');
    process.exit(1);
  }
}
function mount(pathPrefix, name, router, app) {
  assertRouter(name, router);
  app.use(pathPrefix, router);
  console.log(`[MOUNT] ${name} em ${pathPrefix}`);
}

// ===== Agendadores =====
scheduleConciliacao();

// ===== Importação das Rotas =====
const authRoutes            = require('./api/authRoutes');
const userRoutes            = require('./api/userRoutes');
const darsRoutes            = require('./api/darsRoutes');
const adminAuthRoutes       = require('./api/adminAuthRoutes');
const adminRoutes           = require('./api/adminRoutes');
const adminManagementRoutes = require('./api/adminManagementRoutes');
const adminDarsRoutes       = require('./api/adminDarsRoutes');
const adminOficiosRoutes    = require('./api/adminOficiosRoutes');
const permissionariosRoutes = require('./api/permissionariosRoutes');
const botRoutes             = require('./api/botRoutes');

// Routers de assinatura do portal (exporta 2 routers)
const portalAssin = require('./api/portalAssinaturaRoutes');
const portalEventosAssinaturaRouter  = portalAssin.portalEventosAssinaturaRouter;
const documentosAssinafyPublicRouter = portalAssin.documentosAssinafyPublicRouter;

// Routers de eventos (desestruturados)
const {
  adminRoutes:  eventosClientesAdminRoutes,
  publicRoutes: eventosClientesPublicRoutes,
  clientRoutes: eventosClientesClientRoutes
} = require('./api/eventosClientesRoutes');

const eventosRoutes          = require('./api/eventosRoutes');
const adminEventosRoutes     = require('./api/adminEventosRoutes');   // inclui /:id/termo
const webhooksAssinafyRoutes = require('./api/webhooksAssinafyRoutes');
const assinafyRoutes         = require('./routes/assinafy');           // preparar/embedded
const documentosRoutes       = require('./api/documentosRoutes');

// ===== App =====
const app  = express();
app.use(cors({
  origin: '*',               // ⚠️ restrinja em produção
  credentials: true
}));
const PORT = process.env.PORT || 3000;

// Guarda rawBody (webhook HMAC)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: false }));

// Arquivos estáticos
const publicPath = path.join(__dirname, '..', 'public');
console.log(`[STATIC] Servindo arquivos de: ${publicPath}`);
app.use('/', express.static(publicPath));

// ===== Uso das Rotas da API =====
// Autenticação & Permissionários
mount('/api/auth',  'authRoutes',  authRoutes,  app);
mount('/api/user',  'userRoutes',  userRoutes,  app);

// DARs para permissionários
mount('/api/dars',            'darsRoutes',            darsRoutes,            app);
mount('/api/permissionarios', 'permissionariosRoutes', permissionariosRoutes, app);

// Portal do cliente (assinaturas/termo)
mount('/api/portal/eventos', 'portalEventosAssinaturaRouter',  portalEventosAssinaturaRouter,  app); // requer auth no router
mount('/api',                'documentosAssinafyPublicRouter', documentosAssinafyPublicRouter, app); // público p/ status/artefatos

// Administração
mount('/api/admin/auth',        'adminAuthRoutes',       adminAuthRoutes,       app);
mount('/api/admin/dars',        'adminDarsRoutes',       adminDarsRoutes,       app);
mount('/api/admins',            'adminManagementRoutes', adminManagementRoutes, app);
mount('/api/admin',             'adminRoutes',           adminRoutes,           app);
mount('/api/admin',             'adminOficiosRoutes',    adminOficiosRoutes,    app);

// Webhook Assinafy
mount('/api/webhooks/assinafy', 'webhooksAssinafyRoutes', webhooksAssinafyRoutes, app);

// Assinafy: preparar/embedded
mount('/api', 'assinafyRoutes', assinafyRoutes, app);

// Eventos (família)
mount('/api/eventos/clientes',       'eventosClientesPublicRoutes',  eventosClientesPublicRoutes,  app);
mount('/api/portal/eventos',         'eventosClientesClientRoutes',  eventosClientesClientRoutes,  app);
mount('/api/admin/eventos-clientes', 'eventosClientesAdminRoutes',   eventosClientesAdminRoutes,   app);
mount('/api/admin/eventos',          'adminEventosRoutes',           adminEventosRoutes,           app);

mount('/api/eventos',   'eventosRoutes',   eventosRoutes,   app);
mount('/api/documentos','documentosRoutes',documentosRoutes,app);

// Bot
mount('/api/bot', 'botRoutes', botRoutes, app);

// Catch-all para /admin
app.use('/admin', (req, res) => {
  res.sendFile(path.join(publicPath, 'admin', 'login.html'));
});

// ===== Migrações rápidas (garante colunas) =====
ensureClientesEventosColumns(db);
ensureEventosColumns(db);

function ensureClientesEventosColumns(db) {
  db.all(`PRAGMA table_info(Clientes_Eventos)`, [], (err, cols) => {
    if (err) { console.error('[DB] PRAGMA Clientes_Eventos falhou:', err.message); return; }
    const names = new Set((cols || []).map(c => c.name.toLowerCase()));

    const adds = [];
    if (!names.has('cep'))         adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN cep TEXT`);
    if (!names.has('logradouro'))  adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN logradouro TEXT`);
    if (!names.has('numero'))      adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN numero TEXT`);
    if (!names.has('complemento')) adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN complemento TEXT`);
    if (!names.has('bairro'))      adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN bairro TEXT`);
    if (!names.has('cidade'))      adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN cidade TEXT`);
    if (!names.has('uf'))          adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN uf TEXT`);
    if (!names.has('endereco'))    adds.push(`ALTER TABLE Clientes_Eventos ADD COLUMN endereco TEXT`);

    (function runNext(i = 0) {
      if (i >= adds.length) { console.log('[DB] Clientes_Eventos OK.'); return; }
      db.run(adds[i], [], (e) => {
        if (e) console.warn('[DB] Migração ignorada/erro:', adds[i], '-', e.message);
        runNext(i + 1);
      });
    })();
  });
}

function ensureEventosColumns(db) {
  db.all(`PRAGMA table_info(Eventos)`, [], (err, cols) => {
    if (err) { console.error('[DB] PRAGMA Eventos falhou:', err.message); return; }
    const names = new Set((cols || []).map(c => c.name.toLowerCase()));
    if (!names.has('data_vigencia_final')) {
      db.run(`ALTER TABLE Eventos ADD COLUMN data_vigencia_final TEXT`, [], e => {
        if (e) console.warn('[DB] Migração ignorada/erro:', e.message);
        else console.log('[DB] Eventos.data_vigencia_final adicionada.');
      });
    }
  });
}

// ===== Start =====
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
