const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const sqlite3  = require('sqlite3').verbose();

const authMiddleware   = require('../middleware/authMiddleware');
const authorizeRole    = require('../middleware/roleMiddleware');
const { uploadPdf, getDocumentStatus } = require('../services/assinafyClient');

// Se você já tem essa função em outro módulo, importe-a.
// Aqui deixo opcional: caso não exista, só acusamos falta do PDF.
let gerarTermoEventoPdfkitEIndexar = null;
try {
  ({ gerarTermoEventoPdfkitEIndexar } = require('../services/termoService'));
} catch { /* opcional */ }

const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// helpers SQLite
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbAll = (sql, p=[]) => new Promise((res, rej)=> db.all(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

// ---------------- Routers ----------------
const portalEventosAssinaturaRouter = express.Router();
// exige usuário logado no Portal (role CLIENTE_EVENTO ou ADMIN)
portalEventosAssinaturaRouter.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO','ADMIN']));

const documentosAssinafyPublicRouter = express.Router(); // público: vai abrir em nova aba

// ---------------- Util ----------------
async function obterDocumentoTermo(eventoId){
  const doc = await dbGet(
    `SELECT * FROM documentos
     WHERE evento_id = ? AND (tipo = 'termo_evento' OR tipo = 'termo') 
     ORDER BY id DESC LIMIT 1`,
    [eventoId]
  );
  return doc || null;
}

function fileExists(p){
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

// ---------------- Rotas ----------------

/**
 * GET /api/portal/eventos/:id/termo/meta
 * Retorna metadados para o botão "Baixar Termo" do front:
 * { pdf_public_url, url_visualizacao, pdf_url }
 */
portalEventosAssinaturaRouter.get('/:id/termo/meta', async (req, res) => {
  const eventoId = req.params.id;
  try {
    const doc = await obterDocumentoTermo(eventoId);
    if (!doc) return res.status(404).json({ error: 'Termo não encontrado.' });

    // Tente sempre priorizar um link público (se você já publica esse PDF em storage/CDN)
    const payload = {
      pdf_public_url  : doc.pdf_public_url || null,
      url_visualizacao: doc.url_visualizacao || null,
      pdf_url         : doc.pdf_url || null
    };

    // Se só houver caminho local, deixe-o (o front abre numa nova aba se for http(s))
    return res.json(payload);
  } catch (e) {
    console.error('[TERMO][meta] erro:', e);
    res.status(500).json({ error: 'Falha ao obter metadados do termo.' });
  }
});

/**
 * POST /api/portal/eventos/:id/termo/assinafy/link
 * Envia o PDF do termo à Assinafy e retorna uma URL para abrir (j.url).
 * Sempre devolvemos 'url' preenchida (compatível com o seu front).
 */
portalEventosAssinaturaRouter.post('/:id/termo/assinafy/link', async (req, res) => {
  const eventoId = req.params.id;
  try {
    // 1) Garante que existe PDF do termo
    let doc = await obterDocumentoTermo(eventoId);

    if (!doc || !(doc.pdf_public_url || fileExists(doc.pdf_url))) {
      if (typeof gerarTermoEventoPdfkitEIndexar === 'function') {
        await gerarTermoEventoPdfkitEIndexar(eventoId);
        doc = await obterDocumentoTermo(eventoId);
      }
    }

    if (!doc || !(doc.pdf_public_url || fileExists(doc.pdf_url))) {
      return res.status(409).json({ error: 'PDF do termo não encontrado para este evento.' });
    }

    // 2) Se já foi enviado à Assinafy, devolva a URL de abrir
    if (doc.assinafy_id) {
      const open_url = `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`;
      return res.json({ ok: true, id: doc.assinafy_id, url: open_url, open_url });
    }

    // 3) Carrega o PDF em buffer (prioriza arquivo local; se só tiver URL pública, você poderia baixar aqui)
    let buffer = null;
    let filename = 'termo-evento.pdf';

    if (fileExists(doc.pdf_url)) {
      buffer = fs.readFileSync(doc.pdf_url);
      filename = path.basename(doc.pdf_url);
    } else if (doc.pdf_public_url) {
      // (opcional) baixar a URL pública para buffer; simplificando, retornamos erro se não houver local
      return res.status(409).json({ error: 'PDF disponível apenas via URL pública. Baixe e armazene local antes do envio.' });
    }

    // 4) Envia à Assinafy
    const payload = await uploadPdf(buffer, filename, {});

    // 5) Persiste o assinafy_id
    await dbRun(`UPDATE documentos SET assinafy_id = ?, status = ? WHERE id = ?`, [
      payload.id || null,
      'uploaded',
      doc.id
    ]);

    // 6) Monta link compatível com o front (sempre devolver 'url')
    const open_url = `/api/documentos/assinafy/${encodeURIComponent(payload.id)}/open`;
    return res.json({ ok: true, id: payload.id, url: open_url, open_url });
  } catch (e) {
    const status = e?.response?.status;
    console.error('[PORTAL] assinafy link erro:', e);
    if (status === 401) {
      return res.status(401).json({ error: 'Falha ao iniciar assinatura (401). Verifique as credenciais da Assinafy.' });
    }
    return res.status(500).json({ error: 'Falha ao iniciar assinatura.' });
  }
});

/**
 * GET /api/documentos/assinafy/:id/open  (público)
 * Redireciona para o melhor artefato disponível (certificado > original).
 * Se preferir, você pode alterar para pedir assinatura e então abrir um “signingUrl”.
 */
documentosAssinafyPublicRouter.get('/documentos/assinafy/:id/open', async (req, res) => {
  const id = req.params.id;
  try {
    const data = await getDocumentStatus(id); // { artifacts: { certificated, original } ... }
    const artifacts = data?.artifacts || {};
    const best = artifacts.certificated || artifacts.original;
    if (!best) return res.status(404).send('Documento não possui artefatos para abrir.');
    return res.redirect(best);
  } catch (e) {
    console.error('[ASSINAFY][open] erro:', e?.response?.data || e);
    const status = e?.response?.status || 500;
    return res.status(status).send('Não foi possível abrir o documento.');
  }
});

module.exports = {
  portalEventosAssinaturaRouter,
  documentosAssinafyPublicRouter,
};
