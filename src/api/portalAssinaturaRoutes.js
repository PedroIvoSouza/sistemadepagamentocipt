// src/api/portalAssinaturaRoutes.js
// Rotas do Portal + Assinafy
// - MONTADO EM: app.use('/api/portal/eventos', portalEventosAssinaturaRouter)
//     • GET  /:id/termo/meta
//     • POST /:id/termo/assinafy/link
// - MONTADO EM: app.use('/api', documentosAssinafyPublicRouter)
//     • GET  /documentos/assinafy/:id/open
//     • GET  /documentos/assinafy/:id/status

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

// Middlewares do projeto
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

// Cliente Assinafy
const { uploadPdf, getDocumentStatus } = require('../services/assinafyClient');

// ----------------------------------------------------------------------------
// Configuração e instâncias
// ----------------------------------------------------------------------------
const portalEventosAssinaturaRouter   = express.Router();
const documentosAssinafyPublicRouter  = express.Router();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const ASSINAFY_TIMEOUT_MS = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);
const ASSINAFY_DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';

// headers de autenticação para baixar artefatos diretamente da Assinafy
const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();

function apiHeaders() {
  const h = {};
  if (API_KEY) {
    // enviamos todas as variações de case — alguns gateways são sensíveis
    h['X-Api-Key'] = API_KEY;
    h['X-API-KEY'] = API_KEY;
    h['x-api-key'] = API_KEY;
  }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
  return h;
}

const httpsAgent = new https.Agent({
  keepAlive: false,
});

// ----------------------------------------------------------------------------
/** Helpers DB */
// ----------------------------------------------------------------------------
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    })
  );

// ----------------------------------------------------------------------------
/** Verificações auxiliares */
// ----------------------------------------------------------------------------
async function assertEventoDoCliente(eventoId, clienteId) {
  const row = await dbGet(`SELECT 1 FROM Eventos WHERE id = ? AND id_cliente = ?`, [eventoId, clienteId]);
  if (!row) {
    const existe = await dbGet(`SELECT 1 FROM Eventos WHERE id = ?`, [eventoId]);
    if (!existe) {
      const e = new Error('Evento não encontrado.');
      e.status = 404;
      throw e;
    }
    const e = new Error('Você não tem acesso a este evento.');
    e.status = 403;
    throw e;
  }
}

async function findTermoDocumento(eventoId) {
  // tenta por tipo 'termo_evento' e 'termo'
  const doc =
    (await dbGet(
      `SELECT * FROM documentos WHERE evento_id = ? AND (tipo = 'termo_evento' OR tipo = 'termo') ORDER BY id DESC`,
      [eventoId]
    )) || null;
  return doc;
}

// ============================================================================
// 1) CLIENTE_EVENTO (montado em /api/portal/eventos)
//    GET /:id/termo/meta  |  POST /:id/termo/assinafy/link
// ============================================================================
portalEventosAssinaturaRouter.get(
  '/:id/termo/meta',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  async (req, res) => {
    const eventoId = req.params.id;
    try {
      await assertEventoDoCliente(eventoId, req.user.id);
      const doc = await findTermoDocumento(eventoId);
      if (!doc) return res.status(404).json({ error: 'Termo não localizado.' });

      // Preferência: URL pública, depois rota local de "open" se já houver assinafy_id
      const out = {};
      if (doc.pdf_public_url) out.pdf_public_url = doc.pdf_public_url;

      if (doc.assinafy_id) {
        // abrir via proxy local, montado em /api
        out.url_visualizacao = `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`;
      }

      // fallback — se existir pdf local, pode expor via estático (fora daqui)
      if (!out.pdf_public_url && !out.url_visualizacao && doc.pdf_url && fs.existsSync(doc.pdf_url)) {
        out.pdf_url = doc.pdf_url;
      }

      if (!out.pdf_public_url && !out.url_visualizacao && !out.pdf_url) {
        return res.status(409).json({ error: 'Termo ainda não disponível.' });
      }
      res.json(out);
    } catch (e) {
      const st = e.status || 500;
      res.status(st).json({ error: e.message || 'Erro ao buscar metadados do termo.' });
    }
  }
);

portalEventosAssinaturaRouter.post(
  '/:id/termo/assinafy/link',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  async (req, res) => {
    const eventoId = req.params.id;

    try {
      // Segurança: o evento precisa pertencer ao cliente logado
      await assertEventoDoCliente(eventoId, req.user.id);

      // Localiza termo
      let doc = await findTermoDocumento(eventoId);
      if (!doc) {
        return res.status(409).json({ error: 'PDF do termo não encontrado.' });
      }

      // Garante que temos um PDF local
      if (!doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
        return res.status(409).json({ error: 'PDF do termo não encontrado no servidor.' });
      }

      // Se já existe assinafy_id, devolve um "open" link (não depende de ter assinatura criada)
      if (doc.assinafy_id) {
        return res.json({
          ok: true,
          id: doc.assinafy_id,
          url: `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`,
        });
      }

      // Caso contrário: upload para Assinafy e salva assinafy_id
      const buffer = fs.readFileSync(doc.pdf_url);
      const fileName = path.basename(doc.pdf_url);

      const payload = await uploadPdf(buffer, fileName, { name: fileName });
      const assinafyId = payload?.id;

      if (!assinafyId) {
        return res.status(502).json({ error: 'Falha ao enviar documento à Assinafy.' });
      }

      await dbRun(
        `UPDATE documentos SET assinafy_id = ?, status = ? WHERE id = ?`,
        [assinafyId, 'uploaded', doc.id]
      );

      return res.json({
        ok: true,
        id: assinafyId,
        url: `/api/documentos/assinafy/${encodeURIComponent(assinafyId)}/open`,
      });
    } catch (e) {
      if (ASSINAFY_DEBUG) console.error('[PORTAL] assinafy link erro:', e?.response || e);
      res.status(500).json({ error: e.message || 'Falha ao iniciar assinatura.' });
    }
  }
);

// ============================================================================
// 2) PÚBLICO (montado em /api)
//    GET /documentos/assinafy/:id/open  |  GET /documentos/assinafy/:id/status
// ============================================================================
documentosAssinafyPublicRouter.get('/documentos/assinafy/:id/open', async (req, res) => {
  const id = req.params.id;
  try {
    // Consulta status para pegar artifact (certificado preferível)
    const info = await getDocumentStatus(id).catch((err) => {
      if (ASSINAFY_DEBUG) console.error('[DOC/OPEN] getDocumentStatus falhou:', err?.response?.status, err?.message);
      throw err;
    });

    const artifacts = info?.artifacts || {};
    const fileUrl = artifacts.certificated || artifacts.original;
    if (!fileUrl) {
      return res.status(404).send('Documento sem artefato disponível.');
    }

    // Baixa o PDF com autenticação do servidor e faz proxy
    const ax = await axios.request({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        ...apiHeaders(),
        Accept: '*/*',
        Connection: 'close',
      },
      maxBodyLength: Infinity,
      timeout: ASSINAFY_TIMEOUT_MS,
      httpsAgent,
      validateStatus: () => true,
      maxRedirects: 5,
    });

    if (ax.status < 200 || ax.status >= 300) {
      if (ASSINAFY_DEBUG) {
        console.error('[DOC/OPEN] falha ao baixar artefato:', {
          status: ax.status,
          headers: ax.headers,
        });
      }
      // tenta extrair mensagem de erro do corpo (JSON)
      let msg = 'Não foi possível abrir o documento agora.';
      try {
        const chunks = [];
        for await (const c of ax.data) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        const maybe = JSON.parse(body);
        if (maybe?.message) msg = maybe.message;
      } catch (_) {}
      const hint = ax.status === 401 ? ' (credenciais da Assinafy inválidas no servidor)' : '';
      return res.status(502).send(`${msg}${hint}`);
    }

    // ok — stream do PDF
    res.setHeader('Content-Type', 'application/pdf');
    const safeName = (info?.name || `documento-${id}`).replace(/[^a-zA-Z0-9_.-]+/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.pdf"`);
    ax.data.pipe(res);
  } catch (e) {
    const st = e?.response?.status;
    if (ASSINAFY_DEBUG) console.error('[DOC/OPEN] erro inesperado:', st || '', e?.message || e);
    if (st === 401) {
      return res.status(502).send('Falha ao abrir documento (credenciais inválidas no servidor).');
    }
    res.status(502).send('Não foi possível abrir o documento agora.');
  }
});

documentosAssinafyPublicRouter.get('/documentos/assinafy/:id/status', async (req, res) => {
  const id = req.params.id;
  try {
    const info = await getDocumentStatus(id);
    res.json(info);
  } catch (e) {
    const st = e?.response?.status || 500;
    res.status(st).json(e?.response?.data || { error: e.message || 'Erro ao consultar status.' });
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
