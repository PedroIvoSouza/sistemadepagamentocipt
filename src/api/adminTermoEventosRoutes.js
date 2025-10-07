// src/api/adminTermoEventosRoutes.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const db = require('../database/db');
const { getNextNumeroTermo } = require('../services/eventoDarService');
const router = express.Router();

/* ========= SQLite helpers ========= */
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));

/* ========= Utils ========= */
const cm = (n) => (72 * (n / 2.54)); // cm -> pt
const onlyDigits = (v='') => String(v).replace(/\D/g,'');
const moeda = (n) => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(n||0));
const areaFmt = (n) => {
  const x = Number(n||0);
  return x ? `${x.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2})} m²` : '-';
};
const dataExt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
};
const mkPeriodo = (datas) => {
  const arr = String(datas||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!arr.length) return '';
  const ext = arr.map(dataExt);
  return ext.length === 1 ? ext[0] : `${ext[0]} a ${ext[ext.length-1]}`;
};
const sanitizeFile = (s='') => String(s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/["'`]/g,'')
  .replace(/[\/\\]+/g,'-')
  .replace(/[^\w.\-]+/g,'_')
  .replace(/_{2,}/g,'_')
  .replace(/^_+|_+$/g,'');

function parseEspacoUtilizado(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const txt = v.trim();
    if (!txt) return [];
    try {
      if (txt.startsWith('[')) {
        const arr = JSON.parse(txt);
        if (Array.isArray(arr)) return arr;
      }
    } catch { /* ignore */ }
    return txt.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT
  )`);
  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const names = new Set(cols.map(c => c.name));
  const add = (n, def) => names.has(n) ? Promise.resolve() : dbRun(`ALTER TABLE documentos ADD COLUMN ${n} ${def}`);
  await add('permissionario_id','INTEGER');
  await add('evento_id','INTEGER');
  await add('pdf_url','TEXT');
  await add('pdf_public_url','TEXT');
  await add('assinafy_id','TEXT');
  await add('status',"TEXT DEFAULT 'gerado'");
  await add('signed_pdf_public_url','TEXT');
  await add('signed_at','TEXT');
  await add('signer','TEXT');
  await add('created_at','TEXT');
  await add('versao','INTEGER DEFAULT 1');
  await dbRun(`UPDATE documentos SET versao = 1 WHERE versao IS NULL`);
  await dbRun(`DROP INDEX IF EXISTS ux_documentos_evento_tipo`);
  await dbRun(`DROP INDEX IF EXISTS idx_documentos_evento_tipo`);
  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo_versao ON documentos(evento_id, tipo, versao)`);
}

/* ========= Resolve caminho do timbrado ========= */
function resolveLetterheadPath() {
  const p1 = path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png');   // mesmo do ofício
  const p2 = path.join(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png'); // fallback
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  throw new Error(`Imagem de timbrado não encontrada em: ${p1} ou ${p2}`);
}

/* ========= Nome do arquivo ========= */
function nomeArquivo(ev, docId) {
  const termo = sanitizeFile(ev?.numero_termo || 's-n').replace(/\//g,'-');
  const razao = sanitizeFile(ev?.nome_razao_social || 'Cliente');
  // primeira data (YYYY-MM-DD) -> YYYY-MM-DD
  const dataISO = (String(ev?.datas_evento||'').split(',')[0]||'').replace(/[\[\]"]/g,'').trim() || 's-d';
  return `TermoPermissao_${termo}_${razao}_Data-${dataISO}_${docId}.pdf`;
}

/* ========= Token simples ========= */
function gerarToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/* ========= Texto das cláusulas (padrão) ========= */
function clausulasTexto(payload) {
  const p = payload;
  const linhas = [];

  // Processo / Termo
  linhas.push({ bold:false, text:
    `Processo n°: ${p.processo_numero || '-'}\nTermo n°: ${p.termo_numero || '-'}` });

  // Permitente
  linhas.push({ bold:false, text:
    `\nPERMITENTE: ${p.permitente_razao}, CNPJ ${p.permitente_cnpj}, endereço ${p.permitente_endereco}, ` +
    `representado por ${p.permitente_representante_cargo}, Sr(a). ${p.permitente_representante_nome}, ` +
    `CPF ${p.permitente_representante_cpf}.` });

  // Permissionário
  const docPerm = onlyDigits(p.permissionario_cnpj || p.permissionario_cpf || '');
  linhas.push({ bold:false, text:
    `\nPERMISSIONÁRIO(A): ${p.permissionario_razao}, CNPJ/CPF ${docPerm}, endereço ${p.permissionario_endereco}, ` +
    `representado por ${p.permissionario_representante_nome || ''}, CPF ${onlyDigits(p.permissionario_representante_cpf || '')}.` });

  // Cláusula Primeira – Do Objeto
  linhas.push({ bold:true, text:`\nCLÁUSULA PRIMEIRA – DO OBJETO` });
  linhas.push({ bold:false, text:
    `Uso de ${p.local_espaco} do ${p.imovel_nome} para realização de “${p.evento_titulo}” ` +
    (p.data_evento ? `em ${p.data_evento}` : '') +
    (p.hora_inicio && p.hora_fim ? `, das ${p.hora_inicio} às ${p.hora_fim}.` : '.')
  });

  return linhas;
}

/* ========= Desenha tabela (quebra segura) ========= */
function desenharTabela(doc, payload) {
  const left = doc.page.margins.left;
  const top = doc.y + 6; // um respiro
  const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const cols = [
    { w: larguraUtil * 0.45, label: 'Discriminação / Área utilizada' },
    { w: larguraUtil * 0.20, label: 'Área (m²) / Capacidade' },
    { w: larguraUtil * 0.15, label: 'Nº de dias' },
    { w: larguraUtil * 0.20, label: 'Valor total' },
  ];
  const rowH = 24;

  let y = top;

  // Cabeçalho
  let x = left;
  doc.font('Helvetica-Bold').fontSize(10);
  cols.forEach(c => {
    doc.text(c.label, x + 4, y + 6, { width: c.w - 8, align: 'left' });
    doc.rect(x, y, c.w, rowH).stroke('#000');
    x += c.w;
  });
  y += rowH;

  // Linha única com dados do evento
  const discr = `${payload.local_espaco} do ${payload.imovel_nome}\n` +
                `Realização: ${payload.data_evento || '-'}\n` +
                `Montagem: ${payload.data_montagem || payload.data_evento || '-'}\n` +
                `Desmontagem: ${payload.data_desmontagem || payload.data_evento || '-'}`;

  const areaCap = `${payload.area_m2_fmt || '-'} (capacidade para ${payload.capacidade_pessoas || '-'} pessoas)`;

  // quebra segura
  if (y + rowH > doc.page.height - doc.page.margins.bottom - 12) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.font('Helvetica').fontSize(10);
  x = left;
  const cells = [discr, areaCap, String(payload.numero_dias||1), payload.valor_total_fmt || moeda(payload.valor_total||0)];
  cells.forEach((cell, i) => {
    doc.text(String(cell), x + 4, y + 6, { width: cols[i].w - 8, align: i===2 ? 'center' : 'left' });
    doc.rect(x, y, cols[i].w, rowH).stroke('#000');
    x += cols[i].w;
  });

  doc.x = left;
  doc.y = y + rowH + 10;
}

/* ========= Cabeçalho/rodapé simples (token + paginação) ========= */
function printToken(doc, token, qrBuffer) {
  if (!token) return;
  const prevX = doc.x, prevY = doc.y;
  doc.save();
  const x = doc.page.margins.left;
  const qrSize = 40;
  const qrX = doc.page.width - doc.page.margins.right - qrSize;
  const baseY = doc.page.height - doc.page.margins.bottom;
  const aviso =
    'Para checar a autenticidade do documento insira o token abaixo no Portal do Permissionário que pode ser acessado através do qr code ao lado.';
  const avisoWidth = qrX - x - 10;
  doc.fontSize(7).fillColor('#222');
  const avisoHeight = doc.heightOfString(aviso, { width: avisoWidth });
  const avisoY = baseY - avisoHeight - 10;   // 10pt de margem
  const tokenY = avisoY + avisoHeight + 2;
  doc.text(aviso, x, avisoY, { width: avisoWidth });

  const text = `Token: ${token}`;
  doc.fontSize(8).text(text, x, tokenY, { lineBreak:false });

  const qrY = tokenY - qrSize + 8;
  doc.image(qrBuffer, qrX, qrY, { fit: [qrSize, qrSize] });
  doc.restore();
  doc.x = prevX; doc.y = prevY;
}

/* ===========================================================
   GET /api/admin/termos/proximo-numero
   =========================================================== */
router.get(
  '/termos/proximo-numero',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const ano = Number(req.query.ano) || new Date().getFullYear();
      const numeroTermo = await getNextNumeroTermo(db, ano);
      res.json({ numeroTermo });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ===========================================================
   GET /api/admin/eventos/:eventoId/termo
   Gera o TERMO (PDFKit) com timbrado, cabeçalho e rodapé em todas as páginas.
   =========================================================== */
// Rota legada "termo-pdf" redireciona para o endpoint oficial
router.get('/eventos/:eventoId/termo-pdf', (req, res) => {
  const { eventoId } = req.params;
  return res.redirect(302, `/api/admin/eventos/${eventoId}/termo`);
});

router.get(
  '/eventos/:eventoId/termo',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      await ensureDocumentosSchema();
      const { eventoId } = req.params;
      const versaoParam = Number(req.query?.versao);
      const versaoFiltro = Number.isFinite(versaoParam) && versaoParam > 0 ? versaoParam : null;

      const resp = await dbGet(
        `SELECT c.documento_responsavel
           FROM Eventos e
           JOIN Clientes_Eventos c ON c.id = e.id_cliente
          WHERE e.id = ?`,
        [eventoId]
      );
      if (!resp?.documento_responsavel) {
        return res.status(400).json({ error: 'CPF do responsável não informado' });
      }

      const docQuery = versaoFiltro
        ? `SELECT id, token, signed_pdf_public_url, pdf_url, pdf_public_url, versao
             FROM documentos
            WHERE evento_id = ? AND tipo = 'termo_evento' AND COALESCE(versao, 1) = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        : `SELECT id, token, signed_pdf_public_url, pdf_url, pdf_public_url, versao
             FROM documentos
            WHERE evento_id = ? AND tipo = 'termo_evento'
            ORDER BY COALESCE(versao, 1) DESC, created_at DESC, id DESC
            LIMIT 1`;
      const docParams = versaoFiltro ? [eventoId, versaoFiltro] : [eventoId];
      const docAssinado = await dbGet(
        docQuery,
        docParams
      );
      if (!docAssinado && versaoFiltro) {
        return res.status(404).json({ error: 'Versão solicitada não encontrada.' });
      }

      if (docAssinado?.signed_pdf_public_url) {
        const filePath = path.join(
          process.cwd(),
          'public',
          String(docAssinado.signed_pdf_public_url || '').replace(/^[/\\]+/, '')
        );
        if (fs.existsSync(filePath)) {
          if (docAssinado.token) res.set('X-Documento-Token', docAssinado.token);
          res.set('X-Documento-Id', String(docAssinado.id));
          if (docAssinado.versao) res.set('X-Documento-Versao', String(docAssinado.versao));
          return res.sendFile(filePath);
        }
      }

      if (docAssinado?.pdf_url && fs.existsSync(path.resolve(docAssinado.pdf_url))) {
        if (docAssinado.token) res.set('X-Documento-Token', docAssinado.token);
        res.set('X-Documento-Id', String(docAssinado.id));
        if (docAssinado.versao) res.set('X-Documento-Versao', String(docAssinado.versao));
        return res.sendFile(path.resolve(docAssinado.pdf_url));
      }

      const out = await gerarTermoEventoPdfkitEIndexar(eventoId, versaoFiltro ? { versao: versaoFiltro } : {});

      const docInfo = await dbGet(
        versaoFiltro
          ? `SELECT id, token, versao FROM documentos
               WHERE evento_id = ? AND tipo = 'termo_evento' AND COALESCE(versao, 1) = ?
               ORDER BY created_at DESC, id DESC
               LIMIT 1`
          : `SELECT id, token, versao FROM documentos
               WHERE evento_id = ? AND tipo = 'termo_evento'
               ORDER BY COALESCE(versao, 1) DESC, created_at DESC, id DESC
               LIMIT 1`,
        versaoFiltro ? [eventoId, versaoFiltro] : [eventoId]
      );
      if (docInfo?.token) res.set('X-Documento-Token', docInfo.token);
      if (docInfo?.id) res.set('X-Documento-Id', String(docInfo.id));
      if (docInfo?.versao) res.set('X-Documento-Versao', String(docInfo.versao));

      return res.sendFile(out.filePath);
    } catch (err) {
      console.error('[adminTermosEventos] erro:', err);
      return res.status(500).json({ error: 'Erro ao gerar termo.' });
    }
  }
);


module.exports = router;

