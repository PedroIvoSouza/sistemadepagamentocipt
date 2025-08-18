const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { randomUUID } = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Ensure documentos table exists
const initPromise = new Promise((resolve, reject) => {
  db.run(
    `CREATE TABLE IF NOT EXISTS documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      tipo TEXT NOT NULL,
      permissionario_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    err => (err ? reject(err) : resolve())
  );
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function gerarTokenDocumento(tipo, permissionarioId) {
  await initPromise;
  const token = randomUUID();
  await runAsync(
    `INSERT INTO documentos (token, tipo, permissionario_id) VALUES (?, ?, ?)`,
    [token, tipo, permissionarioId || null]
  );
  return token;
}

async function imprimirTokenEmPdf(pdfBase64, token) {
  const pdfBytes = Buffer.from(pdfBase64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  pages.forEach(page => {
    page.drawText(`Token: ${token}`, {
      x: 50,
      y: 20,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
  });
  const modified = await pdfDoc.save();
  return Buffer.from(modified).toString('base64');
}

module.exports = { gerarTokenDocumento, imprimirTokenEmPdf };
