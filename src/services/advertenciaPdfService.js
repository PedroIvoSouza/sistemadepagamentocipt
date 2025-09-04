// src/services/advertenciaPdfService.js
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sqlite3 = require('sqlite3').verbose();

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// ================== Helpers de BD ==================
const dbRun = (sql, params = [], ctx = '') => new Promise((resolve, reject) => {
  console.log('[SQL][RUN]', ctx, '\n ', sql, '\n ', 'params:', params);
  db.run(sql, params, function (err) {
    if (err) {
      console.error('[SQL][RUN][ERRO]', ctx, err.message);
      reject(err);
    } else {
      resolve(this);
    }
  });
});

// ================== Utils ==================
const sanitizeForFilename = (s = '') =>
  String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]+/g, '_')
    .replace(/["'`]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`, [], 'doc/schema-base');

  const cols = await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(documentos)`, [], (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
  const have = new Set(cols.map(c => c.name));
  const add = async (name, def) => {
    if (!have.has(name)) {
      await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`, [], `doc/add-${name}`);
    }
  };

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

  await dbRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`,
    [],
    'doc/index-ux'
  );
}

// ================== Função principal ==================
async function gerarAdvertenciaPdfEIndexar({ advertenciaId = null, evento = {}, cliente = {}, dosFatos = '', clausulas = [], resumoSancao = '', token = null }) {
  console.log('[ADVERTENCIA][SERVICE] gerarAdvertenciaPdfEIndexar');
  await ensureDocumentosSchema();

  const publicDir = path.join(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(publicDir, { recursive: true });
  const fileName = sanitizeForFilename(`Advertencia_${evento.id || 's-e'}_${cliente.nome_razao_social || 'cliente'}.pdf`);
  const filePath = path.join(publicDir, fileName);

  const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5, 2) });
  const ws = fs.createWriteStream(filePath);
  doc.pipe(ws);

  applyLetterhead(doc, {});
  doc.font('Times-Bold').fontSize(14).text('TERMO DE ADVERTÊNCIA', { align: 'center' });
  doc.moveDown();

  doc.font('Times-Roman').fontSize(12);
  doc.text(`Evento: ${evento.nome_evento || evento.nome || ''}`);
  doc.text(`Cliente: ${cliente.nome_razao_social || cliente.nome || ''}`);
  doc.text(`Documento: ${cliente.documento || ''}`);
  doc.moveDown();

  doc.font('Times-Bold').text('DOS FATOS');
  doc.font('Times-Roman').text(dosFatos || '', {
    align: 'justify',
  });
  doc.moveDown();

  if (clausulas && clausulas.length) {
    doc.font('Times-Bold').text('CLÁUSULAS VIOLADAS');
    clausulas.forEach((c) => {
      doc.font('Times-Bold').text(`${c.numero} `, { continued: true });
      doc.font('Times-Roman').text(c.texto, { align: 'justify' });
      doc.moveDown(0.5);
    });
    doc.moveDown();
  }

  doc.font('Times-Bold').text('SANÇÃO APLICADA');
  doc.font('Times-Roman').text(resumoSancao || '', { align: 'justify' });

  const finishPromise = new Promise((resolve, reject) => {
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  doc.end();
  await finishPromise;

  if (!fs.existsSync(filePath)) {
    console.error('[ADVERTENCIA][SERVICE] Falha ao gravar PDF em', filePath);
    throw new Error('Falha ao gerar PDF da advertência');
  }

  // Gera token (se necessário) somente após garantir que o arquivo existe
  if (!token) {
    token = await gerarTokenDocumento('ADVERTENCIA', cliente.id || null, db);
  }

  // Estampa o token
  if (token) {
    const base64 = fs.readFileSync(filePath).toString('base64');
    const stamped = await imprimirTokenEmPdf(base64, token);
    fs.writeFileSync(filePath, Buffer.from(stamped, 'base64'));
  }

  const createdAt = new Date().toISOString();
  const publicUrl = `/documentos/${fileName}`;
  await dbRun(
    `INSERT INTO documentos (tipo, token, evento_id, permissionario_id, pdf_url, pdf_public_url, status, created_at)
     VALUES ('advertencia', ?, ?, ?, ?, ?, 'gerado', ?)
     ON CONFLICT(evento_id, tipo) DO UPDATE SET
       token = excluded.token,
       pdf_url = excluded.pdf_url,
       pdf_public_url = excluded.pdf_public_url,
       status = 'gerado',
       created_at = excluded.created_at`,
    [token || null, evento.id || null, cliente.id || null, filePath, publicUrl, createdAt],
    'advertencia/upsert-documento'
  );

  // Atualiza o registro da advertência com o token gerado e o caminho do PDF
  if (advertenciaId) {
    try {
      await dbRun(
        `UPDATE Advertencias SET token = ?, pdf_url = ?, status = 'gerado' WHERE id = ?`,
        [token, publicUrl, advertenciaId],
        'advertencia/update-record'
      );
    } catch (e) {
      console.error('[ADVERTENCIA][SERVICE] erro ao atualizar Advertencias:', e.message);
    }
  }

  return { filePath, token };
}

module.exports = { gerarAdvertenciaPdfEIndexar };

