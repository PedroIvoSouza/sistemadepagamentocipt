// src/index.js
require('dotenv').config();

// Garante que as migrações do Sequelize sejam executadas ao iniciar
const initPromise = require('./database/init');

console.log('[BOOT] BOT_SHARED_KEY len =', (process.env.BOT_SHARED_KEY || '').length);

const express = require('express');
const cors = require('cors');
const path = require('path');
const { scheduleConciliacao } = require('../cron/conciliarPagamentosmes');

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
const adminSalasRoutes      = require('./api/adminSalasRoutes');
const advertenciasRoutes    = require('./api/advertenciasRoutes');
const adminAdvertenciasRoutes = require('./api/adminAdvertenciasRoutes');
const portalAdvertenciasRoutes = require('./api/portalAdvertenciasRoutes');

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
const salasRoutes            = require('./api/salasRoutes');

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
mount('/api/portal/advertencias', 'portalAdvertenciasRoutes', portalAdvertenciasRoutes, app);

// Administração
mount('/api/admin/auth',        'adminAuthRoutes',       adminAuthRoutes,       app);
mount('/api/admin/dars',        'adminDarsRoutes',       adminDarsRoutes,       app);
mount('/api/admins',            'adminManagementRoutes', adminManagementRoutes, app);
mount('/api/admin',             'adminRoutes',           adminRoutes,           app);
mount('/api/admin',             'adminOficiosRoutes',    adminOficiosRoutes,    app);
mount('/api/admin',             'adminAdvertenciasRoutes', adminAdvertenciasRoutes, app);
mount('/api/admin/salas',       'adminSalasRoutes',      adminSalasRoutes,      app);

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
mount('/api/salas',     'salasRoutes',     salasRoutes,     app);
mount('/api/advertencias','advertenciasRoutes',advertenciasRoutes,app);

// Bot
mount('/api/bot', 'botRoutes', botRoutes, app);

// Catch-all para /admin
app.use('/admin', (req, res) => {
  res.sendFile(path.join(publicPath, 'admin', 'login.html'));
});


// ===== Start =====
initPromise
  .then(async () => {
    try {
      await adminRoutes.ensureIndexes();
    } catch (e) {
      console.error('[adminRoutes] ensureIndexes error:', e.message);
    }

    const server = app.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}.`);
      try {
        require('../cron');
        console.log('[INFO] Agendador de tarefas (cron) iniciado com sucesso.');
      } catch (error) {
        console.error('[ERRO DE CRON] Falha ao iniciar o agendador de tarefas:', error.message);
      }
    });

    server.on('error', error => {
      console.error('[ERRO DE SERVIDOR] Ocorreu um erro:', error);
    });
  })
  .catch(err => {
    console.error('[BOOT] Falha ao executar migrações:', err.message);
    process.exit(1);
  });
