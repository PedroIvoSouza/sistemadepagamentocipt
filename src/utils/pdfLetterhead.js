// src/utils/pdfLetterhead.js
const fs = require('fs');
const path = require('path');

const CM = 28.3464566929; // pontos por cm
const cm = (n) => Math.round(n * CM);

// ABNT: topo/esq = 3 cm; dir/baixo = 2 cm.
// Pedido: +0,5 cm em topo/baixo → topo=3.5; baixo=2.5
// authBlockHeightCm: altura adicional reservada para bloco de autenticação (token/QR)
function abntMargins(extraTopCm = 0.5, extraBottomCm = 0.5, authBlockHeightCm = 0) {
  return {
    top: cm(3 + extraTopCm),     // 3,5 cm ~ 99 pt
    bottom: cm(2 + extraBottomCm + authBlockHeightCm), // inclui espaço para bloco de autenticação
    left: cm(3),                 // 3 cm ~ 85 pt
    right: cm(2),                // 2 cm ~ 57 pt
  };
}

// desenha o PNG de papel timbrado como fundo em TODAS as páginas
function applyLetterhead(doc, opts = {}) {
  const candidates = [
    opts.imagePath, // caminho explícito
    path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png'),
    path.join(__dirname, '..', '..', 'public', 'images', 'papel-timbrado-secti.png'),
  ].filter(Boolean);

  let imgPath = null;
  for (const p of candidates) {
    const full = path.resolve(p);
    try { if (fs.existsSync(full)) { imgPath = full; break; } } catch { /* ignore */ }
  }
  if (!imgPath) return; // sem imagem → segue sem timbrado

  const buf = fs.readFileSync(imgPath);

  const rendered = new WeakSet();
  const render = () => {
    const page = doc.page;
    if (rendered.has(page)) return; // evita renderização dupla
    rendered.add(page);
    doc.save();
    // cobre a página inteira
    doc.image(buf, 0, 0, { width: doc.page.width, height: doc.page.height });
    doc.restore();
  };

  // primeira página
  render();
  // novas páginas
  doc.on('pageAdded', render);

  // garante que o timbrado seja desenhado antes de finalizar o documento
  const originalEnd = doc.end.bind(doc);
  doc.end = (...args) => {
    render();
    return originalEnd(...args);
  };
}

module.exports = { applyLetterhead, abntMargins, cm };
