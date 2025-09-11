// src/services/termoAssinafyService.js
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const {
  uploadPdf,
  ensureSigner,
  createAssignment,
  getBestSigningUrl,
  waitForStatus,
  getDocumentStatus,
} = require('./assinafyClient');

const DEBUG = String(process.env.ASSINAFY_DEBUG || '') === '1';
const DB_PATH = process.env.SQLITE_STORAGE || path.resolve(process.cwd(), './sistemacipt.db');

function openDb() { return new sqlite3.Database(DB_PATH); }
const all = (db, sql, p=[]) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (db, sql, p=[]) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (db, sql, p=[]) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

const PENDING_SIGNATURE_STATES = new Set(['pending_signature','waiting_for_signature','waiting_for_signatures']);

async function getDocumentoExistente(eventoId) {
  const db = openDb();
  try {
    return await get(db, `SELECT token, assinatura_url FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`, [String(eventoId)]);
  } finally { db.close(); }
}

async function getEventoComCliente(eventoId) {
  const db = openDb();
  try {
    const evento = await get(db, `
      SELECT e.*, c.nome_razao_social, c.documento, c.endereco, c.cep,
             c.nome_responsavel, c.documento_responsavel, c.email as email_responsavel, c.telefone as telefone_responsavel
        FROM Eventos e
        JOIN Clientes_Eventos c ON c.id = e.id_cliente
       WHERE e.id = ?;`, [String(eventoId)]);
    const parcelas = await all(db, `
      SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
        FROM DARs_Eventos de
        JOIN dars d ON d.id = de.id_dar
       WHERE de.id_evento = ?
       ORDER BY de.numero_parcela ASC;`, [String(eventoId)]);
    return { evento, parcelas };
  } finally { db.close(); }
}

async function upsertDocumentoPreparado({ eventoId, documentId, assinaturaUrl }) {
  const db = openDb();
  try {
    await run(db, `
      INSERT INTO documentos (tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url, status, created_at)
      VALUES ('termo_evento', ?, NULL, ?, NULL, NULL, 'pendente_assinatura', ?)
      ON CONFLICT(evento_id, tipo) DO UPDATE SET
        token = excluded.token,
        status = 'pendente_assinatura',
        created_at = excluded.created_at;`,
      [documentId, String(eventoId), new Date().toISOString()]);
    try {
      await run(db, `ALTER TABLE documentos ADD COLUMN assinatura_url TEXT;`);
    } catch (_) {}
    await run(db, `UPDATE documentos SET assinatura_url = ? WHERE evento_id = ? AND tipo = 'termo_evento';`,
      [assinaturaUrl || null, String(eventoId)]);
  } finally { db.close(); }
}

/**
 * Prepara (SEM CAMPOS) o Termo do Evento para assinatura virtual.
 * Permite sobrescrever o signatário com { full_name, email, government_id, phone }.
 */
async function prepararTermoEventoSemCampos({ eventoId, pdfPath, pdfFilename, signer, force=false }) {
  // 1) Dados do signatário
  const { evento } = await getEventoComCliente(eventoId);
  const full_name     = signer?.full_name || evento?.nome_responsavel || evento?.nome_razao_social || 'Responsável';
  const email         = signer?.email || evento?.email_responsavel || evento?.email || null;
  const government_id = signer?.government_id || evento?.documento_responsavel || evento?.documento || null;
  const phone         = signer?.phone || evento?.telefone_responsavel || null;
  if (!email) throw new Error('Email do signatário não informado.');

  if (!force) {
    const existente = await getDocumentoExistente(eventoId);
    if (existente?.token) {
      try {
        const stInfo = await getDocumentStatus(existente.token);
        const st = stInfo?.data?.status || stInfo?.status;
        if (DEBUG) console.log('[PREPARAR] Documento existente', existente.token, 'status:', st);
        if (st && PENDING_SIGNATURE_STATES.has(String(st).toLowerCase())) {
          let assinaturaUrl = existente.assinatura_url;
          if (!assinaturaUrl) {
            assinaturaUrl = await getBestSigningUrl(existente.token).catch(()=>null);
            if (assinaturaUrl) {
              const db = openDb();
              try { await run(db, `UPDATE documentos SET assinatura_url = ? WHERE evento_id = ? AND tipo = 'termo_evento'`, [assinaturaUrl, String(eventoId)]); } finally { db.close(); }
            }
          }
          return { documentId: existente.token, signerId: null, assinaturaUrl, status: st, full_name, email };
        }
      } catch (err) {
        if (DEBUG) console.warn('[PREPARAR] Falha ao verificar documento existente:', err.message);
      }
    }
  }

  if (!fs.existsSync(pdfPath)) throw new Error(`PDF não encontrado em ${pdfPath}`);

  // 2) Upload do PDF
  const pdfBuffer = fs.readFileSync(pdfPath);
  const up = await uploadPdf(pdfBuffer, pdfFilename || path.basename(pdfPath), {});
  const documentId = up?.id || up?.data?.id;
  if (!documentId) throw new Error('Falha no upload: id do documento não retornado.');

  if (DEBUG) console.log('[PREPARAR] Upload OK. doc=', documentId);

  // 2.1) Aguarda o processamento do arquivo (a UI mostra “Documento processado”)
  // estados possíveis antes de preparar: uploading -> metadata_processing -> metadata_ready
  await waitForStatus(documentId, (s) => s && s !== 'metadata_processing' && s !== 'uploading', {
    intervalMs: 1000, maxMs: 30000
  });
  const afterProc = await getDocumentStatus(documentId);
  const st0 = afterProc?.data?.status || afterProc?.status;
  if (DEBUG) console.log('[PREPARAR] Status pós-processamento:', st0);

  // 3) Garante signatário e cria o assignment (isto é a “preparação”)
  const signerObj = await ensureSigner({ full_name, email, government_id, phone });
  const signerId = signerObj?.id || signerObj?.data?.id;
  if (!signerId) throw new Error('Falha ao garantir signatário.');

  await createAssignment(documentId, signerId, { /* message, expires_at... */ });

  // 4) Aguarda ficar pronto para assinar (pending_signature ou já certificated)
  const status = await waitForStatus(documentId, (s) => s === 'pending_signature' || s === 'certificated', {
    intervalMs: 1500, maxMs: 120000
  });

  // 5) URL de assinatura (para embed/no e-mail)
  const assinaturaUrl = await getBestSigningUrl(documentId);

  // 6) Atualiza DB local
  await upsertDocumentoPreparado({ eventoId, documentId, assinaturaUrl });

  return { documentId, signerId, assinaturaUrl, status, full_name, email };
}

module.exports = { prepararTermoEventoSemCampos };
