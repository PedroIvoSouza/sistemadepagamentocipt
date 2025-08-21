// src/api/portalAssinaturaRoutes.js
// Rotas do Portal p/ termo + Assinafy (abrir, criar, polling, stream)

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const sqlite3 = require('sqlite3').verbose();
const axios   = require('axios');

const authMiddleware  = require('../middleware/authMiddleware');
const authorizeRole   = require('../middleware/roleMiddleware');

const {
  uploadPdf,
  getDocument,
  getBestSigningUrl,
  ensureSigner,
  createAssignment,
  listAssignments,
} = require('../services/assinafyClient');

const router = express.Router();

const DEBUG   = String(process.env.ASSINAFY_DEBUG || '') === '1';
const TIMEOUT = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);
const BASE    = (process.env.ASSINAFY_API_BASE || 'https://api.assinafy.com.br/v1').replace(/\/+$/, '');
const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();
const INSECURE = String(process.env.ASSINAFY_INSECURE || '') === '1';

const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: !INSECURE,
});

function apiHeaders() {
  const h = {};
  if (API_KEY) {
    h['X-Api-Key'] = API_KEY;
    h['X-API-KEY'] = API_KEY;
    h['x-api-key'] = API_KEY;
  }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
  return h;
}

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const dbGet = (sql, p=[]) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej) => db.run(sql, p, function(e){ e?rej(e):res(this); }));

function onlyDigits(v=''){ return String(v).replace(/\D/g,''); }
function isCpf(d){ d = onlyDigits(d); return d.length===11; }
function isCnpj(d){ d = onlyDigits(d); return d.length===14; }

async function assertEventoDoCliente(eventoId, clienteId) {
  const row = await dbGet(`SELECT 1 FROM Eventos WHERE id=? AND id_cliente=?`, [eventoId, clienteId]);
  if (!row) {
    const ex = await dbGet(`SELECT 1 FROM Eventos WHERE id=?`, [eventoId]);
    const e = new Error(ex ? 'Você não tem acesso a este evento.' : 'Evento não encontrado.');
    e.status = ex ? 403 : 404;
    throw e;
  }
}

async function findTermoDocumento(eventoId){
  return await dbGet(
    `SELECT * FROM documentos WHERE evento_id=? AND (tipo='termo_evento' OR tipo='termo') ORDER BY id DESC`,
    [eventoId]
  );
}

async function getClienteEvento(clienteId){
  return await dbGet(`SELECT * FROM Clientes_Eventos WHERE id=?`, [clienteId]);
}

// ------------------------- 1) META do termo (baixar PDF) -------------------------
router.get(
  '/portal/eventos/:id/termo/meta',
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
      if (doc.assinafy_id) out.url_visualizacao = `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`;
      if (!out.pdf_public_url && !out.url_visualizacao && doc.pdf_url && fs.existsSync(doc.pdf_url)) {
        out.pdf_url = doc.pdf_url; // servidor deve expor estaticamente se quiser
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

// ------------------------- 2) POST iniciar assinatura (cria tudo e tenta url) -------------------------
router.post(
  '/portal/eventos/:id/termo/assinafy/link',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  async (req, res) => {
    const eventoId = req.params.id;
    try {
      await assertEventoDoCliente(eventoId, req.user.id);

      // 2.1 documento
      let doc = await findTermoDocumento(eventoId);
      if (!doc || !doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
        return res.status(409).json({ error: 'PDF do termo não encontrado no servidor.' });
      }

      // 2.2 envia p/ Assinafy se ainda não enviado
      if (!doc.assinafy_id) {
        const buffer = fs.readFileSync(doc.pdf_url);
        const fileName = path.basename(doc.pdf_url);
        const payload = await uploadPdf(buffer, fileName, { name: fileName });
        if (!payload?.id) return res.status(502).json({ error: 'Falha ao enviar documento à Assinafy.' });

        await dbRun(`UPDATE documentos SET assinafy_id=?, status=? WHERE id=?`, [payload.id, 'uploaded', doc.id]);
        doc.assinafy_id = payload.id;
      }

      // 2.3 signatário (dados do cliente)
      const cliente = await getClienteEvento(req.user.id);
      if (!cliente || !cliente.email) return res.status(400).json({ error: 'Cliente sem e-mail cadastrado.' });

      const full_name = (cliente.nome_responsavel && cliente.tipo_pessoa === 'PJ')
        ? cliente.nome_responsavel
        : (cliente.nome_razao_social || 'Cliente');
      const government_id = isCpf(cliente.documento) || isCnpj(cliente.documento) ? onlyDigits(cliente.documento) : undefined;
      const phone = onlyDigits(cliente.telefone || '');

      const signer = await ensureSigner({
        full_name,
        email: String(cliente.email).trim(),
        government_id,
        phone
      });

      // 2.4 assignment
      const beforeLink = await getBestSigningUrl(doc.assinafy_id);
      if (beforeLink) {
        return res.json({ ok:true, url: beforeLink }); // já tinha
      }

      const assign = await createAssignment(doc.assinafy_id, signer.id, {});
      const link = assign?.url || await getBestSigningUrl(doc.assinafy_id);

      if (link) {
        return res.json({ ok:true, url: link });
      }

      // Sem link ainda — mas assignment existe/pendente: devolve estado para o front fazer poll
      return res.json({
        ok: true,
        pending: true,
        email_sent: Boolean(assign?.email_sent),
        message: 'Já existe uma assinatura pendente. O convite pode ter sido enviado por e-mail.'
      });
    } catch (e) {
      if (DEBUG) console.error('[PORTAL] assinafy link erro:', e?.response?.data || e);
      const msg = e?.message || 'Falha ao iniciar assinatura.';
      res.status(500).json({ error: msg });
    }
  }
);

// ------------------------- 2b) GET polling do link -------------------------
router.get(
  '/portal/eventos/:id/termo/assinafy/link',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  async (req, res) => {
    const eventoId = req.params.id;
    try {
      await assertEventoDoCliente(eventoId, req.user.id);
      const doc = await findTermoDocumento(eventoId);
      if (!doc?.assinafy_id) return res.status(404).json({ error: 'Documento ainda não enviado para assinatura.' });

      const link = await getBestSigningUrl(doc.assinafy_id);
      if (link) return res.json({ ok:true, url: link });

      // fallback: vê se há assignments ao menos
      const items = await listAssignments(doc.assinafy_id);
      const has = items && items.length > 0;
      return res.json({ ok:true, pending: true, has_assignment: has });
    } catch (e) {
      if (DEBUG) console.error('[ASSINAFY][POLL LINK] erro:', e?.message || e);
      res.status(500).json({ error: 'Não foi possível consultar o link de assinatura.' });
    }
  }
);

// ------------------------- 3) Público: stream do PDF (original/certificado) -------------------------
router.get('/documentos/assinafy/:id/open', async (req, res) => {
  const id = req.params.id;
  try {
    const info = await getDocument(id);
    const artifacts = info?.artifacts || {};
    const fileUrl = artifacts.certificated || artifacts.original;
    if (!fileUrl) return res.status(404).send('Documento sem artefato disponível.');

    const r = await axios.request({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: { ...apiHeaders(), Accept: '*/*', Connection: 'close' },
      httpsAgent,
      timeout: TIMEOUT,
      proxy: false,
      validateStatus: () => true,
    });

    if (r.status < 200 || r.status >= 300) {
      let msg = 'Não foi possível abrir o documento agora.';
      try {
        const chunks = [];
        for await (const c of r.data) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        const maybe = JSON.parse(body);
        if (maybe?.message) msg = maybe.message;
      } catch {}
      const hint = r.status === 401 ? ' (credenciais inválidas no servidor)' : '';
      return res.status(502).send(`${msg}${hint}`);
    }

    res.setHeader('Content-Type', 'application/pdf');
    const safeName = (info?.name || `documento-${id}`).replace(/[^a-zA-Z0-9_.-]+/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.pdf"`);
    r.data.pipe(res);
  } catch (e) {
    if (DEBUG) console.error('[DOC/OPEN] erro inesperado:', e?.message || e);
    res.status(502).send('Não foi possível abrir o documento agora.');
  }
});

// ------------------------- 4) Diagnóstico opcional -------------------------
router.get('/documentos/assinafy/:id/status', async (req, res) => {
  const id = req.params.id;
  try {
    const info = await getDocument(id);
    res.json(info);
  } catch (e) {
    const st = e?.response?.status || 500;
    res.status(st).json(e?.response?.data || { error: e.message || 'Erro ao consultar status.' });
  }
});

// exporta como função (Router)…
module.exports = router;

// …e também como “named exports” para quem usa destructuring
module.exports.portalEventosAssinaturaRouter = router;
module.exports.documentosAssinafyPublicRouter = router;
