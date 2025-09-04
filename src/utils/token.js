const { randomUUID } = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const generateTokenQr = require('./qrcodeToken');

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

let initPromise;
function ensureTable(db) {
  if (!initPromise) {
    initPromise = new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run(
          `CREATE TABLE IF NOT EXISTS documentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE,
            tipo TEXT NOT NULL,
            caminho TEXT,
            permissionario_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
          err => {
            if (err) return reject(err);
            db.run(
              `CREATE UNIQUE INDEX IF NOT EXISTS idx_documentos_token ON documentos(token)`,
              idxErr => {
                if (idxErr) return reject(idxErr);
                db.all(`PRAGMA table_info(documentos)`, async (e, rows) => {
                  if (e) return reject(e);
                  const cols = rows.map(r => r.name);
                  try {
                    if (!cols.includes('caminho')) {
                      await runAsync(db, `ALTER TABLE documentos ADD COLUMN caminho TEXT`);
                    }
                    if (!cols.includes('permissionario_id')) {
                      await runAsync(
                        db,
                        `ALTER TABLE documentos ADD COLUMN permissionario_id INTEGER`
                      );
                    }
                    resolve();
                  } catch (alterErr) {
                    reject(alterErr);
                  }
                });
              }
            );
          }
        );
      });
    });
  }
  return initPromise;
}

async function gerarTokenDocumento(tipo, permissionarioId, db) {
  await ensureTable(db);
  const token = randomUUID();
  await runAsync(
    db,
    `INSERT INTO documentos (token, tipo, permissionario_id) VALUES (?, ?, ?)`,
    [token, tipo, permissionarioId || null]
  );
  return token;
}

async function imprimirTokenEmPdf(pdfBase64, token) {
  const pdfBytes = Buffer.from(pdfBase64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const qrBuffer = await generateTokenQr(token);
  const qrImage = await pdfDoc.embedPng(qrBuffer);
  const pages = pdfDoc.getPages();
  pages.forEach(page => {
    page.drawText(`Token: ${token}`, {
      x: 50,
      y: 20,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    const qrSize = 40;
    page.drawImage(qrImage, {
      x: page.getWidth() - qrSize - 50,
      y: 10,
      width: qrSize,
      height: qrSize,
    });
  });
  const modified = await pdfDoc.save();
  return Buffer.from(modified).toString('base64');
}

module.exports = { gerarTokenDocumento, imprimirTokenEmPdf };
