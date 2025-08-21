// src/api/portalAssinaturaRoutes.js
// Rotas do Portal relacionadas a Termo + Assinafy (upload, meta, assinatura, open/stream)
// - POST   /api/portal/eventos/:id/termo/assinafy/link   (CLIENTE_EVENTO)
// - GET    /api/portal/eventos/:id/termo/meta            (CLIENTE_EVENTO)
// - GET    /api/documentos/assinafy/:id/open             (PUBLIC)
// - GET    /api/documentos/assinafy/:id/status           (opcional)

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

// middlewares existentes do projeto
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

// cliente Assinafy
const {
  uploadPdf,
  ensureSigner,
  requestSignatures,
  listAssignments,
  getDocumentStatus,
  pickSigningUrl,
  pollSigningUrl,
  unwrap,
} = require('../services/assinafyClient');

const portalEventosAssinaturaRouter  = express.Router();
const documentosAssinafyPublicRouter = express.Router();

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

const ASSINAFY_TIMEOUT_MS = Number(process.env.ASSINAFY_TIMEOUT_MS || 90000);
const ASSINAFY_DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';
const INSECURE = String(process.env.ASSINAFY_INSECURE || '') === '1';

const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: !INSECURE });

// headers de autenticação para baixar artefatos diretamente da Assinafy
const API_KEY = (process.env.ASSINAFY_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.ASSINAFY_ACCESS_TOKEN || '').trim();

function apiHeaders() {
  const h = {};
  if (API_KEY) { h['X-Api-Key'] = API_KEY; h['X-API-KEY'] = API_KEY; h['x-api-key'] = API_KEY; }
  if (ACCESS_TOKEN) h.Authorization = `Bearer ${ACCESS_TOKEN}`;
  return h;
}

// ----------------------------------------------------------------------------
// Helpers DB
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
// Verificações auxiliares
// ----------------------------------------------------------------------------
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
  // tenta por tipo 'termo_evento' e 'termo'
  const doc =
    (await dbGet(
      `SELECT * FROM documentos WHERE evento_id = ? AND (tipo = 'termo_evento' OR tipo = 'termo') ORDER BY id DESC`,
      [eventoId]
    )) || null;
  return doc;
}

async function getClienteEvento(clienteId) {
  return await dbGet(
    `SELECT id, nome_razao_social, email, telefone, documento FROM Clientes_Eventos WHERE id = ?`,
    [clienteId]
  );
}

// ----------------------------------------------------------------------------
// 1) CLIENTE_EVENTO: metadados do termo (para Baixar Termo)
// ----------------------------------------------------------------------------
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
        out.url_visualizacao = `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`;
      }

      // fallback local se houver pdf_url
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

// ----------------------------------------------------------------------------
// helper: localizar link de assinatura para um signer específico
// ----------------------------------------------------------------------------
function pickSigningUrlForSigner(assignments, signerId, email) {
  if (!assignments) return null;
  const arr = Array.isArray(assignments)
    ? assignments
    : (assignments.items && Array.isArray(assignments.items)) ? assignments.items : [];

  for (const a of arr) {
    // tenta nos próprios campos do assignment
    let url = pickSigningUrl(a);
    if (url) return url;

    // tenta nos signers do assignment
    const signers = Array.isArray(a?.signers) ? a.signers : [];
    for (const s of signers) {
      const idMatch = signerId && (s.id === signerId || s.signer_id === signerId);
      const mailMatch = email && (String(s.email || '').toLowerCase() === String(email).toLowerCase());
      if (idMatch || mailMatch) {
        const u = pickSigningUrl(s) || pickSigningUrl(a);
        if (u) return u;
      }
    }
  }
  // último recurso: qualquer link em qualquer assignment
  return pickSigningUrl(arr);
}

// ----------------------------------------------------------------------------
// 2) CLIENTE_EVENTO: iniciar assinatura (idempotente)
// ----------------------------------------------------------------------------
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
      if (!doc) return res.status(409).json({ error: 'PDF do termo não encontrado.' });

      // Garante que temos um PDF local
      if (!doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
        return res.status(409).json({ error: 'PDF do termo não encontrado no servidor.' });
      }

      // Upload se necessário
      let assinafyId = doc.assinafy_id;
      if (!assinafyId) {
        const buffer = fs.readFileSync(doc.pdf_url);
        const fileName = path.basename(doc.pdf_url);
        const up = await uploadPdf(buffer, fileName, { name: fileName });
        assinafyId = up?.id;
        if (!assinafyId) return res.status(502).json({ error: 'Falha ao enviar documento à Assinafy.' });
        await dbRun(`UPDATE documentos SET assinafy_id = ?, status = ? WHERE id = ?`, [
          assinafyId,
          'uploaded',
          doc.id,
        ]);
      }

      // Signer = cliente do evento (se não houver, criamos na Assinafy)
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

      // Se o documento já está pendente de assinatura, NÃO criamos novo assignment
      let info = await getDocumentStatus(assinafyId).catch(() => null);
      const docStatus = (info?.status || '').toString().toLowerCase();

      if (docStatus === 'pending_signature') {
        // reaproveita assignment existente -> tenta pegar link do signer atual
        const assigns = await listAssignments(assinafyId).catch(() => null);

        let url =
          pickSigningUrlForSigner(assigns, signerId, cliente.email) ||
          pickSigningUrl(info) ||
          (await pollSigningUrl(assinafyId, { attempts: 6, delayMs: 1500 }));

        if (url) {
          return res.json({ ok: true, id: assinafyId, url, reused: true });
        }
        // Sem link — provavelmente o provedor disparou e-mail e não expõe URL direto
        return res.json({
          ok: true,
          id: assinafyId,
          email_sent: true,
          message:
            'Já existe uma assinatura pendente. O convite foi enviado por e-mail, e o link direto ainda não foi disponibilizado.',
        });
      }

      // Caso contrário (uploaded/draft), cria assignment novo
      const assign = await requestSignatures(assinafyId, [signerId], {
        message: 'Por favor, assine o termo do evento.',
      });

      // 1ª tentativa: extrair do retorno
      let url = pickSigningUrl(assign);

      // polling para materializar link
      if (!url) url = await pollSigningUrl(assinafyId, { attempts: 6, delayMs: 1500 });

      // última consulta no documento
      if (!url) {
        info = await getDocumentStatus(assinafyId).catch(() => null);
        url = pickSigningUrl(info) || null;
      }

      if (url) {
        return res.json({ ok: true, id: assinafyId, url });
      }

      return res.json({
        ok: true,
        id: assinafyId,
        email_sent: true,
        message:
          'Assignment criado, mas o link ainda não foi disponibilizado. O convite de assinatura deve chegar por e-mail.',
      });
    } catch (e) {
      const st = e?.response?.status;
      const apiMsg = e?.response?.data?.message || e?.message;
      if (ASSINAFY_DEBUG) console.error('[PORTAL] assinafy link erro:', st || '', e?.response?.data || apiMsg);
      res.status(st && st >= 400 && st < 500 ? 400 : 500).json({ error: apiMsg || 'Falha ao iniciar assinatura.' });
    }
  }
);

// ----------------------------------------------------------------------------
// 3) PUBLIC: stream do artefato do documento (original/certificado) para o navegador
// ----------------------------------------------------------------------------
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

    // ok — faz proxy do PDF
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

// ----------------------------------------------------------------------------
// 4) (Opcional) Status bruto para diagnóstico rápido
// ----------------------------------------------------------------------------
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
