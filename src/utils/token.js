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
            token TEXT NOT NULL,
            tipo TEXT NOT NULL,
            caminho TEXT,
            permissionario_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
          err => {
            if (err) return reject(err);
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

/**
 * Desenha o token e o QR Code em um PDF.
 *
 * @param {string} pdfBase64 - PDF em base64.
 * @param {string} token - Token a ser impresso.
 * @param {Object} [opts] - Opções de desenho.
 * @param {boolean} [opts.onlyLastPage=false] - Aplica o desenho apenas na última página.
 * @param {Array} [opts.pages] - Lista de páginas a serem utilizadas. Caso omitida, utiliza todas as páginas do documento.
 * @param {number} [opts.marginX=50] - Margem horizontal esquerda.
 * @param {number} [opts.qrSize=40] - Tamanho do QR Code.
 * @param {number} [opts.qrX] - Posição X do QR Code.
 * @param {number} [opts.qrY] - Posição Y do QR Code.
 * @param {number} [opts.y] - Posição Y do texto do token.
 * @param {number} [opts.avisoWidth] - Largura do texto de aviso.
 */
async function imprimirTokenEmPdf(pdfBase64, token, opts = {}) {
  const pdfBytes = Buffer.from(pdfBase64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const qrBuffer = await generateTokenQr(token);
  const qrImage = await pdfDoc.embedPng(qrBuffer);
  let pages = opts.pages || pdfDoc.getPages();

  if (opts.onlyLastPage && pages.length) {
    pages = [pages[pages.length - 1]];
  }

  const aviso =
    'Para checar a autenticidade do documento insira o token abaixo no Portal do Permissionário que pode ser acessado através do qr code ao lado.';
  const tokenFontSize = 8;
  const avisoFontSize = 7;
  const marginX = opts.marginX ?? 50;
  const qrSize = opts.qrSize ?? 40;

  pages.forEach(page => {
    const pageWidth = page.getWidth();
    const qrX = opts.qrX ?? pageWidth - qrSize - marginX;
    const tokenY = opts.y ?? 10;
    const qrY = opts.qrY ?? (tokenY - tokenFontSize - 2);
    const avisoWidth = (opts.avisoWidth ?? qrX) - marginX - 10;

    const lines = wrapText(aviso, font, avisoFontSize, avisoWidth);
    lines.forEach((line, idx) => {
      page.drawText(line, {
        x: marginX,
        y: tokenY + tokenFontSize + 2 + idx * (avisoFontSize + 2),
        size: avisoFontSize,
        font,
        color: rgb(0, 0, 0),
      });
    });

    page.drawText(`Token: ${token}`, {
      x: marginX,
      y: tokenY,
      size: tokenFontSize,
      font,
      color: rgb(0, 0, 0),
    });

    page.drawImage(qrImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    });
  });

  const modified = await pdfDoc.save();
  return Buffer.from(modified).toString('base64');
}

function wrapText(text, font, size, maxWidth) {
  const words = text.split(' ');
  let lines = [];
  let current = '';
  for (const word of words) {
    const testLine = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, size);
    if (width <= maxWidth) {
      current = testLine;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

module.exports = { gerarTokenDocumento, imprimirTokenEmPdf };
