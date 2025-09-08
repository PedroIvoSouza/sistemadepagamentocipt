// src/api/adminTermoEventosRoutes.js
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const generateTokenQr = require('../utils/qrcodeToken');

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');
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
    token TEXT UNIQUE
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
  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
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
  const avisoY = baseY + 2;
  const tokenY = avisoY + avisoHeight + 2;
  doc.text(aviso, x, avisoY, { width: avisoWidth });

  const text = `Token: ${token}`;
  doc.fontSize(8).text(text, x, tokenY, { lineBreak:false });
  doc.image(qrBuffer, qrX, tokenY - (qrSize - 8), {
    fit: [qrSize, qrSize],
  });
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
router.get(
  '/eventos/:eventoId/termo',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      await ensureDocumentosSchema();

      const { eventoId } = req.params;

      // Se houver PDF assinado, retorna diretamente
      const docAssinado = await dbGet(
        `SELECT signed_pdf_public_url FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
        [eventoId]
      );
      if (docAssinado?.signed_pdf_public_url) {
        const filePath = path.join(
          process.cwd(),
          'public',
          docAssinado.signed_pdf_public_url.replace(/^\/+/, '')
        );
        if (fs.existsSync(filePath)) {
          return res.sendFile(filePath);
        }
      }

      // Evento + Cliente
      const ev = await dbGet(
        `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.email, c.telefone,
                c.endereco, c.nome_responsavel, c.documento_responsavel
           FROM Eventos e
           JOIN Clientes_Eventos c ON c.id = e.id_cliente
          WHERE e.id = ?`, [eventoId]
      );
      if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });

      // Parcelas (para datas de sinal/saldo se quiser no texto)
      const parcelas = await dbAll(
        `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
           FROM DARs_Eventos de
           JOIN dars d ON d.id = de.id_dar
          WHERE de.id_evento = ?
          ORDER BY de.numero_parcela ASC`, [eventoId]
      );

      // Derivados p/ placeholders
      const datasArr = String(ev.datas_evento||'').split(',').map(s=>s.trim()).filter(Boolean);
      const primeiraDataISO = datasArr[0] || null;

      const payload = {
        org_uf: process.env.ORG_UF || 'ESTADO DE ALAGOAS',
        org_secretaria: process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO',
        org_unidade: process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ',

        processo_numero: ev.numero_processo || '',
        termo_numero: ev.numero_termo || '',

        permitente_razao: process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI',
        permitente_cnpj: process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30',
        permitente_endereco: process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140',
        permitente_representante_nome: process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO',
        permitente_representante_cargo: process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO',
        permitente_representante_cpf: process.env.PERMITENTE_REP_CPF || '053.549.204-93',

        permissionario_razao: ev.nome_razao_social || '',
        permissionario_cnpj: onlyDigits(ev.documento || ''),
        permissionario_endereco: ev.endereco || '',
        permissionario_representante_nome: ev.nome_responsavel || '',
        permissionario_representante_cpf: onlyDigits(ev.documento_responsavel || ''),

        evento_titulo: ev.nome_evento || '',
        local_espaco: parseEspacoUtilizado(ev.espaco_utilizado).join(', ') || 'AUDITÓRIO',
        imovel_nome: process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ',

        data_evento: dataExt(primeiraDataISO),
        hora_inicio: ev.hora_inicio || '-',
        hora_fim: ev.hora_fim || '-',
        data_montagem: dataExt(primeiraDataISO),
        data_desmontagem: dataExt(primeiraDataISO),

        area_m2_fmt: areaFmt(ev.area_m2),
        capacidade_pessoas: process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313,

        numero_dias: ev.total_diarias || (datasArr.length || 1),
        valor_total: ev.valor_final || 0,
        valor_total_fmt: moeda(ev.valor_final || 0),

        vigencia_fim_datahora: ev.data_vigencia_final
          ? `${new Date(ev.data_vigencia_final+'T12:00:00').toLocaleDateString('pt-BR')} às 12h` : '',

        pagto_sinal_data: dataExt(parcelas[0]?.data_vencimento || ''),
        pagto_saldo_data: dataExt(parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || ''),

        fundo_nome: process.env.FUNDO_NOME || 'FUNDENTES',
        cidade_uf: process.env.CIDADE_UF || 'Maceió/AL',
        data_assinatura: dataExt(new Date().toISOString()),
      };

      // ========== Gera PDF em memória ==========
      const tokenDoc = gerarToken();
      const qrBuffer = await generateTokenQr(tokenDoc);
      const letterheadPath = resolveLetterheadPath();
      const margins = abntMargins(0.5, 0.5, 2); // inclui espaço para bloco de autenticação
      const doc = new PDFDocument({ size: 'A4', margins });
      doc.on('pageAdded', () => {
        // applyLetterhead já foi plugado pelo helper
        doc.x = doc.page.margins.left;
        doc.y = doc.page.margins.top;
        printToken(doc, tokenDoc, qrBuffer);
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));

      // Timbrado (todas as páginas)
      applyLetterhead(doc, { imagePath: letterheadPath });

      // Cursor inicial e token a cada página
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
      printToken(doc, tokenDoc, qrBuffer);

      const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ====== PARÁGRAFO INICIAL (recúo 6 cm, JUSTIFICADO) ======
      // “TERMO DE PERMISSÃO…” justificado dentro de uma coluna deslocada 6cm à direita
      {
        const blocoX = doc.page.margins.left + cm(6);           // recúo 6cm
        const blocoW = larguraUtil - cm(6);                      // coluna até a margem direita
        const textoIntro =
          `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO A ${payload.permitente_razao} ` +
          `E DO OUTRO ${payload.permissionario_razao}`.toUpperCase();

        doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
           .text(textoIntro, blocoX, doc.y, { width: blocoW, align: 'justify' });
        doc.moveDown(1.2);
      }

      // ====== BLOCO: Processo / Termo / Partes ======
      const linhas = clausulasTexto(payload);
      for (const it of linhas) {
        doc.font(it.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11)
           .fillColor('#000').text(it.text, { width: larguraUtil, align: it.bold ? 'left' : 'justify' });
      }

      // ====== TABELA ======
      desenharTabela(doc, payload);

      // ====== Demais cláusulas (resumo fiel ao seu texto padrão) ======
      const addClausula = (titulo, corpo) => {
        doc.font('Helvetica-Bold').fontSize(11).text(`\n${titulo.toUpperCase()}`, { width: larguraUtil });
        doc.font('Helvetica').fontSize(11).text(corpo, { width: larguraUtil, align: 'justify', lineGap: 2 });
      };

      addClausula('Cláusula Segunda – Da Vigência',
        `O prazo de vigência se inicia na data de assinatura do presente termo até ${payload.vigencia_fim_datahora}.`);

      addClausula('Cláusula Terceira – Do Pagamento',
        `O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${
          payload.valor_total_fmt
        }, através de Documento de Arrecadação – DAR, efetuado em favor do ${
          payload.fundo_nome
        }, devendo ser pago o valor de 50% até ${
          payload.pagto_sinal_data
        } e o restante até ${
          payload.pagto_saldo_data
        }. Ficam mantidas as demais condições do texto padrão (água, esgoto, energia elétrica, reserva e desistência).`);

      addClausula('Cláusula Quarta – Das Obrigações do Permitente',
        `Ceder o espaço nas condições acordadas e fiscalizar a utilização. Parágrafo único: espaços físicos disponíveis conforme regulamento do ${payload.imovel_nome}; ` +
        `não inclui baias/coworking; vedada apresentação musical fora do auditório e consumo de alimentos/bebidas no auditório; descumprimento sujeita a multa de 10% do valor de locação.`);

      addClausula('Cláusula Quinta – Das Obrigações da Permissionária',
        `Utilizar o espaço para o fim específico; zelar pelo imóvel; montagem/desmontagem no período; indenizar danos ao patrimônio e a terceiros; ` +
        `respeitar lotação; arcar com segurança/limpeza/container/remoção de lixo; restituir o espaço; participar de check list; ` +
        `apresentar layout e, se necessário, providenciar gerador; não usar porta de emergência indevidamente; ` +
        `proibido consumo de comidas/bebidas no auditório; proibido som/apresentação musical fora do auditório, sob pena de multa.`);

      addClausula('Cláusula Sexta – Das Penalidades',
        `Multa de 10% do valor da permissão pelo descumprimento; correção pelo IPCA e juros de 1% a.m.; ` +
        `rescisão por desistência até 30 dias: perda da taxa de reserva + multa de 20%; ` +
        `poderá haver impedimento de novas reservas por até 2 anos em caso de violação e inadimplemento.`);

      addClausula('Cláusula Sétima – Da Rescisão',
        `Inexecução total/parcial sujeita às sanções (Lei nº 14.133/2021). ` +
        `Rescisão pelo(a) permissionário(a) com notificação mínima (30 dias eventos particulares / 90 dias eventos públicos). ` +
        `Atraso mínimo impede alteração de data (desistência definitiva); poderá remarcar 1 vez em até 1 ano, condicionado à disponibilidade; ` +
        `sinistro/incêndio/impossibilidade de posse ensejam rescisão automática; rescisões devem ser formalmente motivadas com contraditório e ampla defesa.`);

      addClausula('Cláusula Oitava – Omissões Contratuais',
        `Casos omissos serão decididos pela PERMITENTE conforme Lei nº 14.133/2021, demais normas aplicáveis e, subsidiariamente, o Código de Defesa do Consumidor.`);

      addClausula('Cláusula Nona – Do Foro',
        `Fica eleito o Foro da Cidade de Maceió – AL para dirimir quaisquer dúvidas oriundas do presente Termo.`);

      // Assinaturas
      doc.moveDown(1);
      doc.font('Helvetica').fontSize(11).text(`${payload.cidade_uf}, ${payload.data_assinatura}.`, {
        width: larguraUtil, align: 'left'
      });

      const linhaAssin = (rotulo) => {
        const h = 60;
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
        doc.moveDown(2.5);
        doc.text(''.padEnd(60,'_'), { width: larguraUtil, align: 'center' });
        doc.moveDown(0.2);
        doc.text(rotulo, { width: larguraUtil, align: 'center' });
      };

      linhaAssin('PERMITENTE');
      linhaAssin('PERMISSIONÁRIA');
      linhaAssin('TESTEMUNHA – CPF');
      linhaAssin('TESTEMUNHA – CPF');

      // Finaliza
      doc.end();

      // ====== Ao terminar, salva em disco + indexa + devolve download ======
      doc.on('end', async () => {
        try {
          const pdfBuf = Buffer.concat(chunks);

          // cria registro (UPSERT por (evento_id, tipo))
          const createdAt = new Date().toISOString();
          const token = tokenDoc;

          // cria pasta
          const dir = path.join(process.cwd(), 'public', 'documentos');
          fs.mkdirSync(dir, { recursive: true });

          // precisamos do id para compor nome; primeiro insere (ou busca) e pega id
          await dbRun(
            `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, status, created_at)
             VALUES (?, ?, NULL, ?, 'gerado', ?)
             ON CONFLICT(evento_id, tipo) DO UPDATE SET
               token=excluded.token,
               status='gerado',
               created_at=excluded.created_at`,
            ['termo_evento', token, eventoId, createdAt]
          );

          const docRow = await dbGet(`SELECT id FROM documentos WHERE evento_id = ? AND tipo = ?`, [eventoId, 'termo_evento']);
          const docId = docRow?.id || 0;

          const fileName = nomeArquivo(ev, docId);
          const filePath = path.join(dir, fileName);
          fs.writeFileSync(filePath, pdfBuf);

          const publicUrl = `/documentos/${fileName}`;
          await dbRun(`UPDATE documentos SET pdf_url = ?, pdf_public_url = ? WHERE id = ?`, [filePath, publicUrl, docId]);

          // devolve download
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          res.setHeader('X-Document-Token', token);
          return res.send(pdfBuf);
        } catch (e) {
          console.error('[adminTermosEventos] pós-geração erro:', e);
          return res.status(500).json({ error: 'Erro ao finalizar o PDF do termo.' });
        }
      });

    } catch (err) {
      console.error('[adminTermosEventos] erro:', err);
      return res.status(500).json({ error: 'Erro ao gerar termo.' });
    }
  }
);

module.exports = router;
