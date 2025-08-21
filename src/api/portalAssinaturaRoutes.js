// src/api/portalAssinaturaRoutes.js
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const {
  uploadPdf,
  ensureSigner,
  requestSignatures,
  getDocumentStatus,
  pickSigningUrl,
  pollSigningUrl,
  unwrap,
} = require('../services/assinafyClient');

const portalEventosAssinaturaRouter  = express.Router();
const documentosAssinafyPublicRouter = express.Router();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const ASSINAFY_TIMEOUT_MS = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);
const ASSINAFY_DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';
const INSECURE = String(process.env.ASSINAFY_INSECURE || '') === '1';

const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: !INSECURE });

const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
function apiHeaders() {
  const h = {};
  if (API_KEY) { h['X-Api-Key'] = API_KEY; h['X-API-KEY'] = API_KEY; h['x-api-key'] = API_KEY; }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
  return h;
}

// DB helpers
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

async function assertEventoDoCliente(eventoId, clienteId) {
  const row = await dbGet(`SELECT 1 FROM Eventos WHERE id = ? AND id_cliente = ?`, [eventoId, clienteId]);
  if (!row) {
    const existe = await dbGet(`SELECT 1 FROM Eventos WHERE id = ?`, [eventoId]);
    const e = new Error(existe ? 'Você não tem acesso a este evento.' : 'Evento não encontrado.');
    e.status = existe ? 403 : 404;
    throw e;
  }
}

async function findTermoDocumento(eventoId) {
  return await dbGet(`
    SELECT * FROM documentos
     WHERE evento_id = ? AND (tipo = 'termo_evento' OR tipo = 'termo')
     ORDER BY id DESC
  `, [eventoId]);
}

async function getClienteEvento(clienteId) {
  return await dbGet(`
    SELECT id, nome_razao_social, email, telefone, documento
      FROM Clientes_Eventos
     WHERE id = ?
  `, [clienteId]);
}

// ---------------- 1) Metadados para "Baixar Termo" ----------------
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

      const out = {};
      if (doc.pdf_public_url) out.pdf_public_url = doc.pdf_public_url;
      if (doc.assinafy_id)   out.url_visualizacao = `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`;
      if (!out.pdf_public_url && !out.url_visualizacao && doc.pdf_url && fs.existsSync(doc.pdf_url)) {
        out.pdf_url = doc.pdf_url;
      }
      if (!out.pdf_public_url && !out.url_visualizacao && !out.pdf_url) {
        return res.status(409).json({ error: 'Termo ainda não disponível.' });
      }
      res.json(out);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Erro ao buscar metadados do termo.' });
    }
  }
);

// -------- 2) Iniciar assinatura: upload, signer, assignment + polling --------
portalEventosAssinaturaRouter.post(
  '/:id/termo/assinafy/link',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  async (req, res) => {
    const eventoId = req.params.id;

    try {
      await assertEventoDoCliente(eventoId, req.user.id);

      let doc = await findTermoDocumento(eventoId);
      if (!doc) return res.status(409).json({ error: 'PDF do termo não encontrado.' });
      if (!doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
        return res.status(409).json({ error: 'PDF do termo não encontrado no servidor.' });
      }

      // Upload (se necessário)
      let assinafyId = doc.assinafy_id;
      if (!assinafyId) {
        const buffer   = fs.readFileSync(doc.pdf_url);
        const fileName = path.basename(doc.pdf_url);
        const up = await uploadPdf(buffer, fileName, { name: fileName });
        assinafyId = up?.id;
        if (!assinafyId) return res.status(502).json({ error: 'Falha ao enviar documento à Assinafy.' });
        await dbRun(`UPDATE documentos SET assinafy_id = ?, status = ? WHERE id = ?`, [assinafyId, 'uploaded', doc.id]);
      }

      // Signer = cliente do evento
      const cliente = await getClienteEvento(req.user.id);
      if (!cliente || !cliente.email) return res.status(409).json({ error: 'Cliente sem e-mail cadastrado.' });

      const signer = await ensureSigner({
        full_name:     cliente.nome_razao_social || 'Cliente',
        email:         cliente.email,
        government_id: cliente.documento,
        phone:         cliente.telefone,
      });
      const signerId = signer?.id;
      if (!signerId) return res.status(502).json({ error: 'Falha ao criar/localizar signatário na Assinafy.' });

      // Cria assignment
      const assign = await requestSignatures(assinafyId, [signerId], {
        message: 'Por favor, assine o termo do evento.',
      });

      // 1ª tentativa: extrair do próprio retorno
      let url = pickSigningUrl(assign);

      // Polling (até ~9s por padrão)
      if (!url) url = await pollSigningUrl(assinafyId, { attempts: 6, delayMs: 1500 });

      // Último fallback: tentar no documento agora
      if (!url) {
        const docInfo = await getDocumentStatus(assinafyId).catch(() => null);
        url = pickSigningUrl(docInfo) || null;
      }

      if (url) {
        return res.json({ ok: true, id: assinafyId, url });
      }

      // Sem link — muitas vezes significa que o convite foi disparado por e-mail
      return res.json({
        ok: true,
        id: assinafyId,
        email_sent: true,
        message: 'Convite de assinatura enviado por e-mail pelo provedor. O link direto ainda não foi disponibilizado.',
      });
    } catch (e) {
      const st = e?.response?.status;
      const apiMsg = e?.response?.data?.message || e?.message;
      if (ASSINAFY_DEBUG) console.error('[PORTAL] assinafy link erro:', st || '', e?.response?.data || apiMsg);
      res.status(st && st >= 400 && st < 500 ? 400 : 500).json({ error: apiMsg || 'Falha ao iniciar assinatura.' });
    }
  }
);

// ---------------- 3) Público: proxy do PDF ----------------
documentosAssinafyPublicRouter.get('/documentos/assinafy/:id/open', async (req, res) => {
  const id = req.params.id;
  try {
    const info = unwrap(await getDocumentStatus(id));
    const artifacts = info?.artifacts || {};
    const fileUrl = artifacts.certificated || artifacts.original;
    if (!fileUrl) return res.status(404).send('Documento sem artefato disponível.');

    const ax = await axios.request({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: { ...apiHeaders(), Accept: '*/*', Connection: 'close' },
      maxBodyLength: Infinity,
      timeout: ASSINAFY_TIMEOUT_MS,
      httpsAgent,
      validateStatus: () => true,
      maxRedirects: 5,
    });

    if (ax.status < 200 || ax.status >= 300) {
      let msg = 'Não foi possível abrir o documento agora.';
      try {
        const chunks = []; for await (const c of ax.data) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        const maybe = JSON.parse(body);
        if (maybe?.message) msg = maybe.message;
      } catch {}
      const hint = ax.status === 401 ? ' (credenciais da Assinafy inválidas no servidor)' : '';
      return res.status(502).send(`${msg}${hint}`);
    }

    res.setHeader('Content-Type', 'application/pdf');
    const safeName = (info?.name || `documento-${id}`).replace(/[^a-zA-Z0-9_.-]+/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.pdf"`);
    ax.data.pipe(res);
  } catch (e) {
    const st = e?.response?.status;
    if (ASSINAFY_DEBUG) console.error('[DOC/OPEN] erro:', st || '', e?.message || e);
    if (st === 401) return res.status(502).send('Falha ao abrir documento (credenciais inválidas no servidor).');
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
