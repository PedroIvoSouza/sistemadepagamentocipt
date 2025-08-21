// src/api/documentosRoutes.js
// Rotas de documentos — preserva endpoints clássicos e adiciona integração Assinafy + utilitários de termo

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const sqlite3  = require('sqlite3').verbose();

const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');
const { uploadPdf, getDocumentStatus, downloadSignedPdf } = require('../services/assinafyClient');

const router = express.Router();

// ===== DB setup =====
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Helpers DB (promises)
const dbGet = (sql, p=[]) => new Promise((res, rej)=> db.get(sql, p, (e, r)=> e?rej(e):res(r)));
const dbAll = (sql, p=[]) => new Promise((res, rej)=> db.all(sql, p, (e, r)=> e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); }));

async function ensureDocumentosSchema(){
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`);
  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const have = new Set(cols.map(c=>c.name));
  const add = async (name, def) => { if(!have.has(name)) await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`); };
  await add('permissionario_id', 'INTEGER');
  await add('evento_id', 'INTEGER');
  await add('pdf_url', 'TEXT');
  await add('pdf_public_url', 'TEXT');
  await add('assinafy_id', 'TEXT');
  await add('status', "TEXT DEFAULT 'gerado'");
  await add('signed_pdf_public_url', 'TEXT');
  await add('signed_at', 'TEXT');
  await add('signer', 'TEXT');
  await add('created_at', 'TEXT');
  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
}
ensureDocumentosSchema().catch(()=>{});

// ===== Utils =====
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DOCS_DIR   = path.join(PUBLIC_DIR, 'documentos');
const SIGNED_DIR = path.join(DOCS_DIR, 'assinados');
fs.mkdirSync(SIGNED_DIR, { recursive: true });

function safeSendFile(res, absPath, downloadName){
  if (!absPath || !fs.existsSync(absPath)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  res.setHeader('Content-Type', 'application/pdf');
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  return res.sendFile(absPath);
}

// ===================================================================================
//                               ENDPOINTS CLÁSSICOS
// ===================================================================================

// Lista todos os documentos
router.get('/', async (_req, res) => {
  try {
    const rows = await dbAll(`SELECT * FROM documentos ORDER BY id DESC`);
    res.json(rows);
  } catch (e) {
    console.error('[documentos]/ GET erro:', e.message);
    res.status(500).json({ error: 'Erro ao listar documentos.' });
  }
});

// Busca documento por ID
router.get('/:id', async (req, res) => {
  try {
    const row = await dbGet(`SELECT * FROM documentos WHERE id=?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Documento não encontrado.' });
    res.json(row);
  } catch (e) {
    console.error('[documentos]/:id GET erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar documento.' });
  }
});

// Lista documentos por evento
router.get('/por-evento/:eventoId', async (req, res) => {
  try {
    const rows = await dbAll(`SELECT * FROM documentos WHERE evento_id=? ORDER BY id DESC`, [req.params.eventoId]);
    res.json(rows);
  } catch (e) {
    console.error('[documentos]/por-evento GET erro:', e.message);
    res.status(500).json({ error: 'Erro ao listar documentos do evento.' });
  }
});

// Baixa/abre o PDF a partir do id do documento
router.get('/:id/pdf', async (req, res) => {
  try {
    const doc = await dbGet(`SELECT * FROM documentos WHERE id=?`, [req.params.id]);
    if (!doc || !doc.pdf_url) return res.status(404).json({ error: 'Documento não encontrado.' });
    return safeSendFile(res, path.resolve(doc.pdf_url));
  } catch (e) {
    console.error('[documentos]/:id/pdf erro:', e.message);
    res.status(500).json({ error: 'Erro ao servir PDF.' });
  }
});

// Baixa o PDF assinado, se houver
router.get('/:id/signed', async (req, res) => {
  try {
    const doc = await dbGet(`SELECT * FROM documentos WHERE id=?`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });
    if (doc.signed_pdf_public_url) {
      const abs = path.join(PUBLIC_DIR, doc.signed_pdf_public_url.replace(/^\//,''));
      return safeSendFile(res, abs);
    }
    return res.status(404).json({ error: 'Versão assinada não disponível.' });
  } catch (e) {
    console.error('[documentos]/:id/signed erro:', e.message);
    res.status(500).json({ error: 'Erro ao servir PDF assinado.' });
  }
});

// Upsert genérico (mantido para retrocompatibilidade)
router.post('/upsert', async (req, res) => {
  const { tipo, evento_id, pdf_url, pdf_public_url, token=null, status='gerado' } = req.body || {};
  if (!tipo || !evento_id) return res.status(400).json({ error: 'tipo e evento_id são obrigatórios.' });
  try {
    const createdAt = new Date().toISOString();
    await dbRun(
      `INSERT INTO documentos (tipo, token, evento_id, pdf_url, pdf_public_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(evento_id, tipo) DO UPDATE SET
          pdf_url=excluded.pdf_url, pdf_public_url=excluded.pdf_public_url,
          status=excluded.status, created_at=excluded.created_at`,
      [tipo, token, evento_id, pdf_url || null, pdf_public_url || null, status, createdAt]
    );
    const doc = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo=?`, [evento_id, tipo]);
    res.json({ ok:true, documento: doc });
  } catch (e) {
    console.error('[documentos]/upsert erro:', e.message);
    res.status(500).json({ error: 'Erro ao gravar documento.' });
  }
});

// ===================================================================================
//                               TERMO DO EVENTO
// ===================================================================================

// Gera (se necessário) e baixa o termo do evento (PDF)
router.get('/termo/:eventoId', async (req, res) => {
  const eventoId = req.params.eventoId;
  try {
    let docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    if (!docRow || !docRow.pdf_url || !fs.existsSync(docRow.pdf_url)) {
      await gerarTermoEventoPdfkitEIndexar(eventoId);
      docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    }
    if (!docRow || !docRow.pdf_url) return res.status(404).json({ error: 'Termo não encontrado.' });
    const abs = path.resolve(docRow.pdf_url);
    return safeSendFile(res, abs, `termo_evento_${eventoId}.pdf`);
  } catch (e) {
    console.error('[documentos]/termo/:eventoId GET erro:', e);
    res.status(500).json({ error: 'Erro ao gerar/servir termo.' });
  }
});

// Força re-geração do termo e devolve metadados
router.post('/termo/:eventoId/generate', async (req, res) => {
  const eventoId = req.params.eventoId;
  try {
    const out = await gerarTermoEventoPdfkitEIndexar(eventoId);
    res.json({ ok:true, ...out });
  } catch (e) {
    console.error('[documentos]/termo/:eventoId/generate erro:', e);
    res.status(500).json({ error: 'Falha ao gerar termo.' });
  }
});

// Devolve metadados do termo (URL pública, status, assinafy_id etc.)
router.get('/termo/:eventoId/meta', async (req, res) => {
  const eventoId = req.params.eventoId;
  try {
    let docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    if (!docRow || !docRow.pdf_url || !fs.existsSync(docRow.pdf_url)) {
      await gerarTermoEventoPdfkitEIndexar(eventoId);
      docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    }
    if (!docRow) return res.status(404).json({ error: 'Termo não encontrado.' });
    res.json({
      ok:true,
      documento_id: docRow.id,
      evento_id: eventoId,
      status: docRow.status || 'gerado',
      pdf_public_url: docRow.pdf_public_url || null,
      assinafy_id: docRow.assinafy_id || null,
      signed_pdf_public_url: docRow.signed_pdf_public_url || null,
      signed_at: docRow.signed_at || null
    });
  } catch (e) {
    console.error('[documentos]/termo/:eventoId/meta erro:', e);
    res.status(500).json({ error: 'Erro ao obter metadados do termo.' });
  }
});

// Apenas disponibiliza a URL pública do PDF (útil para front abrir em nova aba)
router.post('/termo/:eventoId/disponibilizar', async (req, res) => {
  const eventoId = req.params.eventoId;
  try {
    const docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    if (!docRow || !docRow.pdf_public_url) return res.status(404).json({ error: 'Termo não disponível publicamente.' });
    res.json({ ok:true, pdf_public_url: docRow.pdf_public_url });
  } catch (e) {
    console.error('[documentos]/termo/:eventoId/disponibilizar erro:', e);
    res.status(500).json({ error: 'Erro ao disponibilizar termo.' });
  }
});

// ===================================================================================
//                               ASSINAFY
// ===================================================================================

// Envia o termo do evento para a Assinafy (admin/serviço geral)
router.post('/termo/:eventoId/assinafy/send', async (req, res) => {
  const eventoId = req.params.eventoId;
  try {
    let docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    if (!docRow || !docRow.pdf_url || !fs.existsSync(docRow.pdf_url)) {
      await gerarTermoEventoPdfkitEIndexar(eventoId);
      docRow = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [eventoId]);
    }
    if (!docRow || !docRow.pdf_url || !fs.existsSync(docRow.pdf_url)) {
      return res.status(409).json({ error: 'PDF do termo não encontrado.' });
    }
    if (docRow.assinafy_id) {
      return res.json({ ok:true, id: docRow.assinafy_id, message: 'Documento já enviado.' });
    }
    const buffer = fs.readFileSync(docRow.pdf_url);
    const filename = path.basename(docRow.pdf_url);
    const callbackUrl = process.env.ASSINAFY_CALLBACK_URL || undefined;
    const resp = await uploadPdf(buffer, filename, { callbackUrl });
    await dbRun(`UPDATE documentos SET assinafy_id=?, status='enviado' WHERE id=?`, [resp.id, docRow.id]);
    res.json({ ok:true, id: resp.id });
  } catch (e) {
    console.error('[documentos] /termo/:eventoId/assinafy/send erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha no envio' });
  }
});

// Abre/redireciona para a tela de assinatura (fallback se a API não devolveu URL direta)
router.get('/assinafy/:id/open', async (req, res) => {
  const id = req.params.id;
  try {
    const st = await getDocumentStatus(id);
    const url = st.url || st.signUrl || st.signerUrl || st.signingUrl;
    if (url) return res.redirect(url);
    // fallback: devolve JSON com o status quando não há URL
    return res.json({ ok:true, id, status: st });
  } catch (e) {
    console.error('[documentos] /assinafy/:id/open erro:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao abrir assinatura.' });
  }
});

// Consulta status na Assinafy
router.get('/assinafy/:id/status', async (req, res) => {
  try {
    const st = await getDocumentStatus(req.params.id);
    res.json({ ok:true, status: st });
  } catch (e) {
    console.error('[documentos] /assinafy/:id/status erro:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao consultar status.' });
  }
});

// Baixa a versão assinada (via cache local se existir; se não, baixa da Assinafy agora)
router.get('/assinafy/:id/download-signed', async (req, res) => {
  const id = req.params.id;
  try {
    const doc = await dbGet(`SELECT * FROM documentos WHERE assinafy_id=?`, [id]);
    if (doc?.signed_pdf_public_url) {
      const abs = path.join(PUBLIC_DIR, doc.signed_pdf_public_url.replace(/^\//,''));
      return safeSendFile(res, abs, `termo_assinado_${doc.evento_id || id}.pdf`);
    }
    // baixa agora
    const bin = await downloadSignedPdf(id);
    const fileName = `termo_assinado_${id}.pdf`;
    const abs = path.join(SIGNED_DIR, fileName);
    fs.writeFileSync(abs, Buffer.from(bin));
    const pub = `/documentos/assinados/${fileName}`;
    if (doc) {
      await dbRun(`UPDATE documentos SET signed_pdf_public_url=?, status='assinado', signed_at=? WHERE id=?`,
        [pub, new Date().toISOString(), doc.id]);
    }
    return safeSendFile(res, abs, fileName);
  } catch (e) {
    console.error('[documentos] /assinafy/:id/download-signed erro:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao baixar PDF assinado.' });
  }
});

// Webhook da Assinafy — atualiza status e armazena o PDF assinado
router.post('/assinafy/webhook', express.json({ type:'application/json' }), async (req, res) => {
  try {
    // Validação simples por segredo
    const secret = process.env.ASSINAFY_WEBHOOK_SECRET;
    const provided = req.headers['x-assinafy-signature'] || req.headers['x-webhook-secret'] || req.query.secret;
    if (secret && String(provided) !== String(secret)) {
      return res.status(401).json({ error: 'Assinatura do webhook inválida.' });
    }

    const payload = req.body || {};
    const id = payload.id || payload.documentId || payload.document_id;
    const status = payload.status || payload.event || '';
    const signer = payload.signer || null;

    if (!id) return res.status(400).json({ error: 'ID do documento ausente no webhook.' });

    // Atualiza status básico
    await dbRun(`UPDATE documentos SET status=?, signer=? WHERE assinafy_id=?`, [String(status||'').toLowerCase(), signer, id]);

    // Se concluído/assinado, baixa e salva localmente
    const statusNorm = String(status||'').toLowerCase();
    if (['signed', 'concluded', 'completed', 'assinado', 'finalizado'].includes(statusNorm)) {
      try {
        const bin = await downloadSignedPdf(id);
        const fileName = `termo_assinado_${id}.pdf`;
        const abs = path.join(SIGNED_DIR, fileName);
        fs.writeFileSync(abs, Buffer.from(bin));
        const pub = `/documentos/assinados/${fileName}`;
        await dbRun(`UPDATE documentos SET signed_pdf_public_url=?, signed_at=?, status='assinado' WHERE assinafy_id=?`,
          [pub, new Date().toISOString(), id]);
      } catch (e) {
        console.error('[webhook] falha ao salvar PDF assinado:', e?.response?.data || e.message);
      }
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('[documentos] /assinafy/webhook erro:', e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao processar webhook.' });
  }
});

// ===================================================================================
//                             ROTAS AUXILIARES / LEGADAS
// ===================================================================================

// Compat: baixa termo por caminho público (quando já há pdf_public_url)
router.get('/termo-public/:eventoId', async (req, res) => {
  try {
    const doc = await dbGet(`SELECT * FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [req.params.eventoId]);
    if (!doc || !doc.pdf_public_url) return res.status(404).json({ error: 'Termo não disponível publicamente.' });
    const abs = path.join(PUBLIC_DIR, doc.pdf_public_url.replace(/^\//,''));
    return safeSendFile(res, abs);
  } catch (e) {
    console.error('[documentos]/termo-public erro:', e.message);
    res.status(500).json({ error: 'Erro ao servir termo público.' });
  }
});

// Compat: retorna apenas a URL pública (se existir)
router.get('/termo-url/:eventoId', async (req, res) => {
  try {
    const doc = await dbGet(`SELECT pdf_public_url FROM documentos WHERE evento_id=? AND tipo='termo_evento'`, [req.params.eventoId]);
    if (!doc?.pdf_public_url) return res.status(404).json({ error: 'URL não disponível.' });
    res.json({ url: doc.pdf_public_url });
  } catch (e) {
    console.error('[documentos]/termo-url erro:', e.message);
    res.status(500).json({ error: 'Erro ao retornar URL do termo.' });
  }
});

module.exports = router;
