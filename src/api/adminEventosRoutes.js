// src/api/adminEventosRoutes.js
const express = require('express');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { criarEventoComDars, atualizarEventoComDars } = require('../services/eventoDarService');


const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService'); 

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');
const db = require('../database/db');

const router = express.Router();

/* ========= Helpers gerais ========= */
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sanitizeForFilename = (s = '') =>
  String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]+/g, '_')
    .replace(/["'`]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
const cm = (n) => n * 28.3464567; // 1 cm em pontos PDF

const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n || 0));
const fmtArea = (n) => {
  const num = Number(n || 0);
  return num ? `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²` : '-';
};
const fmtDataExtenso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
};

/* ========= SQLite helpers com log ========= */
const dbGet = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][GET]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.get(sql, p, (err, row) => err ? (console.error('[SQL][GET][ERRO]', ctx, err.message), reject(err)) : (console.log('[SQL][GET][OK]', ctx), resolve(row)));
  });

const dbAll = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][ALL]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.all(sql, p, (err, rows) => err ? (console.error('[SQL][ALL][ERRO]', ctx, err.message), reject(err)) : (console.log('[SQL][ALL][OK]', ctx, 'rows:', rows?.length ?? 0), resolve(rows)));
  });

const dbRun = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    console.log('[SQL][RUN]', ctx, '\n ', sql, '\n ', 'params:', p);
    db.run(sql, p, function (err) {
      if (err) { console.error('[SQL][RUN][ERRO]', ctx, err.message); reject(err); }
      else { console.log('[SQL][RUN][OK]', ctx, 'lastID:', this.lastID, 'changes:', this.changes); resolve(this); }
    });
  });

function nomeArquivo(ev, idDoc) {
  const razao = String(ev?.nome_razao_social || 'Cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'_');

  const termo = String(ev?.numero_termo || 's-n').replace(/[\/\\]+/g, '-');
  const dataPrimeira = (String(ev?.datas_evento||'').split(',')[0]||'').trim();

  return `TermoPermissao_${termo}_${razao}_Data-${dataPrimeira || 's-d'}_${idDoc}.pdf`;
}

/* ========= Schema documentos: garante colunas/índice ========= */
async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`, [], 'doc/schema-base');

  const cols = await dbAll(`PRAGMA table_info(documentos)`, [], 'doc/schema-info');
  const have = new Set(cols.map(c => c.name));
  const add = async (name, def) => { if (!have.has(name)) await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`, [], `doc/add-${name}`); };

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

  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`, [], 'doc/index-ux');
}

/* ========= Blocos de desenho PDF ========= */
function drawHeader(doc) {
  // se quiser algo textual além do timbrado, coloque aqui
  // Ex.: doc.fontSize(9).fillColor('#444').text('SECRETARIA...', doc.page.margins.left, doc.page.margins.top - cm(0.8));
}

function drawFooter(doc, page, total) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // Número de página (direita)
  doc.font('Times-Roman').fontSize(9).fillColor('#333')
     .text(`Página ${page} de ${total}`, right - 120, bottom + 6, { width: 120, align: 'right' });
}

function drawTituloCabecalho(doc, orgUF, orgSec, orgUni) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  const opts = { width: largura, align: 'center' };

  doc.text(orgUF?.toUpperCase() || 'ESTADO DE ALAGOAS', opts);
  doc.text(orgSec?.toUpperCase() || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO', opts);
  doc.text(orgUni?.toUpperCase() || 'CENTRO DE INOVAÇÃO DO JARAGUÁ', opts);
  doc.moveDown(0.8);
}

function drawParagrafoAbertura(doc, texto) {
  const left = doc.page.margins.left + cm(6); // recuo de 6 cm
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right - cm(6);
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  doc.text(texto, left, doc.y, { width: largura, align: 'justify' });
  doc.moveDown(1);
}

function drawLinhaInfo(doc, rotulo, valor) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12).fillColor('#000')
     .text(`${rotulo} ${valor}`, { width: largura, align: 'left' });
}

function drawParagrafo(doc, texto) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12).fillColor('#000')
     .text(texto, { width: largura, align: 'justify' });
  doc.moveDown(0.6);
}

function drawClausula(doc, titulo) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.5);
  doc.font('Times-Bold').fontSize(12).text(titulo.toUpperCase(), { width: largura, align: 'left' });
}

function drawTabelaDiscriminacao(doc, dados) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const cols = [
    { w: largura * 0.47, label: 'Discriminação / Área utilizada' },
    { w: largura * 0.18, label: 'Área (m²) / Capacidade' },
    { w: largura * 0.15, label: 'Nº de dias' },
    { w: largura * 0.20, label: 'Valor total' },
  ];

  const rowH = 20;
  let y = doc.y + 4;
  let x = doc.page.margins.left;

  const drawRow = (cells, yy, bold = false) => {
    let xx = x;
    doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(11);
    cells.forEach((cell, i) => {
      doc.text(String(cell), xx + 4, yy + 5, { width: cols[i].w - 8, align: i === 0 ? 'left' : (i === 3 ? 'right' : 'left') });
      doc.rect(xx, yy, cols[i].w, rowH).stroke('#000');
      xx += cols[i].w;
    });
  };

  // Cabeçalho
  drawRow(cols.map(c => c.label), y, true);
  y += rowH;

  // Conteúdo
  const col1 = [
    dados.discriminacao,
    `Realização: ${dados.realizacao}`,
    `Montagem: ${dados.montagem}`,
    `Desmontagem: ${dados.desmontagem}`,
  ].join('\n');

  drawRow(
    [
      col1,
      `${dados.area} (capacidade para ${dados.capacidade} pessoas)`,
      String(dados.dias),
      fmtMoeda(dados.valor)
    ],
    y
  );

  doc.y = y + rowH + 6;
}

/* ========= Rotas protegidas ========= */
router.use(adminAuthMiddleware);

/**
 * Criar evento + emitir DARs
 */
router.post('/', async (req, res) => {
  console.log('[DEBUG] Recebido no backend /api/admin/eventos:', JSON.stringify(req.body, null, 2));
  try {
    const { eventoGratuito, justificativaGratuito, ...rest } = req.body || {};
    const eventoId = await criarEventoComDars(db, { ...rest, eventoGratuito, justificativaGratuito }, {
      emitirGuiaSefaz,
      gerarTokenDocumento,
      imprimirTokenEmPdf,
    });
    res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });
  } catch (err) {
    console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
  }
});

/**
 * Listar eventos (admin)
 */
router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT e.id, e.nome_evento, e.espaco_utilizado, e.area_m2,
             e.valor_final, e.status, e.data_vigencia_final,
             e.numero_oficio_sei, e.numero_processo, e.numero_termo,
             e.hora_inicio, e.hora_fim, e.hora_montagem, e.hora_desmontagem,
             c.nome_razao_social AS nome_cliente
        FROM Eventos e
        JOIN Clientes_Eventos c ON e.id_cliente = c.id
       ORDER BY e.id DESC`;
    const rows = await dbAll(sql, [], 'listar-eventos');
    res.json(rows);
  } catch (err) {
    console.error('[admin/eventos] listar erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor ao buscar eventos.' });
  }
});

/**
 * Listar DARs de um evento
 */
router.get('/:eventoId/dars', async (req, res) => {
  const { eventoId } = req.params;
  try {
    const rows = await dbAll(
      `SELECT
         de.numero_parcela,
         de.valor_parcela,
         d.id AS dar_id,
         d.data_vencimento AS dar_venc,
         d.status AS dar_status,
         d.pdf_url AS dar_pdf
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`,
      [eventoId],
      'listar-dars-por-evento'
    );
    res.json({ dars: rows });
  } catch (err) {
    console.error('[admin/eventos] listar DARs erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
  }
});

/**
 * GET /api/admin/eventos/:id -> detalhes para edição
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const ev = await dbGet(
      `SELECT e.*, c.nome_razao_social AS nome_cliente, c.tipo_cliente
         FROM Eventos e
         JOIN Clientes_Eventos c ON c.id = e.id_cliente
        WHERE e.id = ?`,
      [id],
      'evento/get-by-id'
    );

    if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });

    let datas = [];
    try {
      if (typeof ev.datas_evento === 'string') {
        datas = ev.datas_evento.trim().startsWith('[')
          ? JSON.parse(ev.datas_evento)
          : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(ev.datas_evento)) {
        datas = ev.datas_evento;
      }
    } catch { /* noop */ }

    const parcelas = await dbAll(
      `SELECT 
          de.numero_parcela,
          de.valor_parcela            AS valor,
          de.data_vencimento          AS vencimento,
          d.id                        AS dar_id,
          d.status                    AS dar_status,
          d.pdf_url                   AS dar_pdf,
          d.numero_documento          AS dar_numero
         FROM DARs_Eventos de
         JOIN dars d ON d.id = de.id_dar
        WHERE de.id_evento = ?
        ORDER BY de.numero_parcela ASC`,
      [id],
      'evento/get-parcelas'
    );

    const payload = {
      evento: {
        id: ev.id,
        id_cliente: ev.id_cliente,
        nome_evento: ev.nome_evento,
        espaco_utilizado: ev.espaco_utilizado,
        area_m2: ev.area_m2,
        datas_evento: datas,
        total_diarias: ev.total_diarias,
        valor_bruto: ev.valor_bruto,
        tipo_desconto_auto: ev.tipo_desconto,
        desconto_manual_percent: ev.desconto_manual,
        valor_final: ev.valor_final,
        numero_processo: ev.numero_processo,
        numero_termo: ev.numero_termo,
        evento_gratuito: ev.evento_gratuito,
        justificativa_gratuito: ev.justificativa_gratuito,
        status: ev.status,
        nome_cliente: ev.nome_cliente,
        tipo_cliente: ev.tipo_cliente,
        hora_inicio: ev.hora_inicio,
        hora_fim: ev.hora_fim,
        hora_montagem: ev.hora_montagem,
        hora_desmontagem: ev.hora_desmontagem
      },
      parcelas
    };

    return res.json(payload);
  } catch (err) {
    console.error('[admin/eventos/:id] erro:', err.message);
    return res.status(500).json({ error: 'Erro interno ao buscar o evento.' });
  }
});

/* Alias */
router.get('/:id/detalhes', async (req, res) => {
  req.url = `/${req.params.id}`;
  return router.handle(req, res);
});

/**
 * PUT /api/admin/eventos/:id -> atualiza e reemite DARs
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { eventoGratuito, justificativaGratuito, ...rest } = req.body || {};
    await atualizarEventoComDars(db, id, { ...rest, eventoGratuito, justificativaGratuito }, {
      emitirGuiaSefaz,
      gerarTokenDocumento,
      imprimirTokenEmPdf,
    });
    await atualizarEventoComDars(db, id, req.body, { emitirGuiaSefaz, gerarTokenDocumento, imprimirTokenEmPdf });
    return res.json({ message: 'Evento atualizado e DARs reemitidas com sucesso.', id: Number(id) });
  } catch (err) {
    console.error('[admin/eventos PUT/:id] erro:', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Erro ao atualizar o evento.' });
  }
});

/**
 * POST /api/admin/eventos/:eventoId/dars/:darId/reemitir
 */
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
  const { eventoId, darId } = req.params;
  console.log(`[ADMIN] Reemitir DAR ID: ${darId} do Evento ID: ${eventoId}`);

  try {
    const row = await dbGet(
      `
      SELECT e.nome_evento,
             e.hora_inicio, e.hora_fim, e.hora_montagem, e.hora_desmontagem,
             de.numero_parcela,
             (SELECT COUNT(*) FROM DARs_Eventos WHERE id_evento = e.id) AS total_parcelas,
             d.valor, d.data_vencimento,
             c.nome_razao_social, c.documento, c.endereco, c.cep
        FROM dars d
        JOIN DARs_Eventos de ON d.id = de.id_dar
        JOIN Eventos e       ON de.id_evento = e.id
        JOIN Clientes_Eventos c ON e.id_cliente = c.id
       WHERE d.id = ? AND e.id = ?
      `,
      [darId, eventoId],
      'reemitir/buscar-contexto'
    );

    if (!row) return res.status(404).json({ error: 'DAR ou Evento não encontrado.' });

    const documentoLimpo = onlyDigits(row.documento);
    const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
    const [ano, mes] = row.data_vencimento.split('-');

    const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
    if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');
    const payloadSefaz = {
      versao: '1.0',
      contribuinteEmitente: {
        codigoTipoInscricao: tipoInscricao,
        numeroInscricao: documentoLimpo,
        nome: row.nome_razao_social,
        codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
        descricaoEndereco: row.endereco,
        numeroCep: onlyDigits(row.cep)
      },
      receitas: [{
        codigo: receitaCod,
        competencia: { mes: Number(mes), ano: Number(ano) },
        valorPrincipal: row.valor,
        valorDesconto: 0.00,
        dataVencimento: row.data_vencimento
      }],
      dataLimitePagamento: row.data_vencimento,
      observacao: `CIPT Evento: ${row.nome_evento} (Montagem ${row.hora_montagem || '-'}; Evento ${row.hora_inicio || '-'}-${row.hora_fim || '-'}; Desmontagem ${row.hora_desmontagem || '-'}) | Parcela ${row.numero_parcela}/${row.total_parcelas} (Reemissão)`
    };

    const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);
    const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
    retornoSefaz.pdfBase64 = await imprimirTokenEmPdf(retornoSefaz.pdfBase64, tokenDoc);

    await dbRun(
      `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`,
      [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId],
      'reemitir/update-dars'
    );

    console.log(`[ADMIN] DAR ID: ${darId} reemitida. Novo número: ${retornoSefaz.numeroGuia}`);
    res.status(200).json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });
  } catch (err) {
    console.error(`[ERRO] Ao reemitir DAR ID ${darId}:`, err.message);
    res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

/**
 * Gera o TERMO em PDFKit com timbrado/cabeçalho/rodapé e salva em /public/documentos (idempotente)
 */
router.get('/:id/termo', async (req, res) => {
  const { id } = req.params;
  try {
    // Gera via PDFKit (com timbrado/cabeçalho/rodapé) e indexa
    const out = await gerarTermoEventoPdfkitEIndexar(id);

    const stat = fs.statSync(out.filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(out.filePath).pipe(res);
  } catch (err) {
    console.error('[admin/eventos] termo erro:', err);
    res.status(500).json({ error: 'Falha ao gerar termo' });
  }
});




    // ===== 3) PDF =====
    const letterheadPath = path.join(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png');
    const publicDir = path.join(process.cwd(), 'public', 'documentos');
    fs.mkdirSync(publicDir, { recursive: true });

    const fileName = sanitizeForFilename(
      `TermoPermissao_${String(ev.numero_termo || 's-n').replace(/\//g, '_')}_${(ev.nome_razao_social || 'Cliente')}_${(primeiraDataISO || 's-d')}.pdf`
    );
    const filePath = path.join(publicDir, fileName);

    // cria o doc com bufferPages para numerar depois
    const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5), bufferPages: true });
    const writeStream = fs.createWriteStream(filePath);

    // headers de resposta p/ download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // duplica o stream: salva arquivo e envia pro cliente
    doc.pipe(writeStream);
    doc.pipe(res);

    // timbrado em todas as páginas
    applyLetterhead(doc, { imagePath: letterheadPath });

    // cursor inicial
    doc.font('Times-Roman').fontSize(12);
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;

    // Cabeçalho institucional (3 linhas)
    drawTituloCabecalho(doc, orgUF, orgSec, orgUni);

    // Parágrafo de abertura (6 cm à esquerda, justificado)
    const textoAbertura = `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO A ${permitenteRazao} E DO OUTRO ${(ev.nome_razao_social || '').toUpperCase()}.`;
    drawParagrafoAbertura(doc, textoAbertura);

    // Processo / Termo
    drawLinhaInfo(doc, 'Processo n°:', ev.numero_processo || '');
    drawLinhaInfo(doc, 'Termo n°:', ev.numero_termo || '');
    doc.moveDown(0.6);

    // Partes
    drawParagrafo(doc,
      `PERMITENTE: ${permitenteRazao}, inscrita no CNPJ/MF sob o nº ${permitenteCnpj} e estabelecida no endereço ${permitenteEnd}, de acordo com a representação legal que lhe é outorgada por portaria e representada pelo responsável: ${permitenteRepCg}, Sr(a). ${permitenteRepNm}, inscrito(a) no CPF sob o nº ${permitenteRepCpf}.`
    );
    drawParagrafo(doc,
      `PERMISSIONÁRIO(A): ${ev.nome_razao_social || ''}, inscrito(a) no CNPJ/MF sob o nº ${onlyDigits(ev.documento || '')}, estabelecido(a) em ${ev.endereco || '-'}, representado por ${ev.nome_responsavel || '-'}, CPF nº ${onlyDigits(ev.documento_responsavel || '')}.`
    );

    // CLÁUSULA 1
    drawClausula(doc, 'Cláusula Primeira – Do Objeto');
    drawParagrafo(doc,
      `1.1 - O presente instrumento tem como objeto o uso pelo(a) PERMISSIONÁRIO(A) de área do ${ev.espaco_utilizado || 'AUDITÓRIO'} do imóvel denominado ${imovelNome}, para realização de “${ev.nome_evento || ''}”, a ser realizada em ${dataEventoExt}, das ${ev.hora_inicio || '-'} às ${ev.hora_fim || '-'}, devendo a montagem ser realizada no mesmo dia do evento e a desmontagem ao final, conforme proposta em anexo, estando disponível o uso do seguinte espaço:`
    );

    // Tabela de discriminação
    drawTabelaDiscriminacao(doc, {
      discriminacao: `${ev.espaco_utilizado || 'AUDITÓRIO'} do ${imovelNome}`,
      realizacao: dataEventoExt || '-',
      montagem: fmtDataExtenso(primeiraDataISO) || '-',
      desmontagem: fmtDataExtenso(primeiraDataISO) || '-',
      area: fmtArea(ev.area_m2),
      capacidade: capDefault,
      dias: ev.total_diarias || (datasArr.length || 1),
      valor: ev.valor_final || 0,
    });

    // CLÁUSULA 2
    drawClausula(doc, 'Cláusula Segunda – Da Vigência');
    drawParagrafo(doc, `2.1 - O prazo de vigência se inicia na data de assinatura do presente termo até ${ev.data_vigencia_final ? new Date(ev.data_vigencia_final).toLocaleDateString('pt-BR') : '-'}, às 12h.`);

    // CLÁUSULA 3 – PAGAMENTO
    drawClausula(doc, 'Cláusula Terceira – Do Pagamento');
    drawParagrafo(doc,
      `3.1 - O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${fmtMoeda(ev.valor_final || 0)}, através de Documento de Arrecadação – DAR, efetuado em favor da conta do Fundo Estadual de Desenvolvimento Científico, Tecnológico e de Educação Superior (${fundoNome}), devendo ser pago o valor de 50% até ${fmtDataExtenso(parcelas[0]?.data_vencimento || '')} e o restante até ${fmtDataExtenso(parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || '')}.`
    );
    drawParagrafo(doc, '3.1.1. Fica incluso ao valor estabelecido no item anterior o pagamento relativo somente ao consumo de água, esgoto e energia elétrica.');
    drawParagrafo(doc, '3.1.2. Após o pagamento a data estará reservada, de modo que não haverá devolução de qualquer valor pago em caso de desistência.');
    drawParagrafo(doc, '3.1.3. No caso de não haver a quitação total do valor, a reserva estará desfeita.');

    // CLÁUSULA 4 – OBRIGAÇÕES DO PERMITENTE
    drawClausula(doc, 'Cláusula Quarta – Das Obrigações do PermITENTE');
    drawParagrafo(doc, '4.1 - Ceder o espaço, na data e hora acordadas, entregando o local em perfeitas condições de higiene, limpeza e conservação.');
    drawParagrafo(doc, '4.2 - Fiscalizar, por meio do gestor indicado pela SECTI, a utilização do espaço objeto deste termo de permissão, podendo impedir a utilização inadequada do espaço cedido evitando assim danos ao patrimônio do objeto do presente termo de permissão.');
    drawParagrafo(doc,
      'Parágrafo Único - Os espaços físicos disponíveis são as áreas do auditório do Centro de Inovação do Jaraguá destinada à realização de eventos, compreendendo o espaço de 429,78 m² (banheiro masculino e feminino, 02 salas de tradução, 09 espaços destinados a cadeirantes, palco - com acesso externo -, 02 coxias, 02 camarins, 01 copa e 01 área técnica), do espaço aberto em frente ao auditório, não incluindo as baias e nem o coworking público, não sendo permitida apresentação musical fora do auditório, bem como não é permitido servir alimentos/bebidas dentro do auditório, de modo que qualquer violação destas será cobrada uma multa no valor de 10% do valor de locação.'
    );

    // CLÁUSULA 5 – OBRIGAÇÕES DA PERMISSIONÁRIA
    drawClausula(doc, 'Cláusula Quinta – Das Obrigações da Permissionária');
    [
      '5.1 - Utilizar o espaço destinado no imóvel em questão para o fim específico do evento descrito na cláusula primeira.',
      '5.2 - Conservar o imóvel como se lhe pertencesse, fazendo com que seu uso e gozo sejam pacíficos e harmônicos.',
      '5.3 - A montagem e desmontagem de materiais e equipamentos do(a) PERMISSIONÁRIO(A) ou de terceiros, dentro do período de vigência, conforme reserva.',
      '5.4 - A indenização pelos danos causados que, por si, seus empregados, prepostos e participantes do evento causarem ao mobiliário, equipamentos e acessórios das áreas locadas, independente de qualquer vistoria judicial prévia.',
      '5.5 - A indenização por danos causados a terceiros no imóvel utilizado.',
      '5.6 - A retirada do material e equipamentos utilizados dentro do período de vigência.',
      '5.7 - Respeitar a lotação da área utilizada, sob pena do PERMITENTE providenciar a retirada do público excedente.',
      '5.8 - Responsabilizar-se pelas despesas realizadas com a segurança, manutenção e conservação do bem permitido.',
      '5.9 - Responsabilizar-se pela limpeza e manutenção da área locada durante a montagem, realização e desmontagem do evento, inclusive a compra dos materiais de limpeza.',
      '5.10 - Responsabilizar-se pela locação de container e contratação de remoção de lixo durante a montagem, realização e desmontagem do evento.',
      '5.11 - Restituir o espaço permitido em perfeito estado e condições, conforme Termo de Vistoria.',
      '5.12 - O espaço locado deverá ser utilizado para o fim específico do evento descrito na cláusula primeira.',
      '5.13 - Para a locação da referida área, o permissionário deverá, no momento da montagem do evento, participar de um check list de vistoria junto a servidor designado pela SECTI e, ao final do evento, na desmontagem, entregar o espaço nas mesmas condições encontradas, incluindo infraestrutura, mobília e limpeza do ambiente, sob pena de multa no valor de locação do espaço.',
      '5.14 - O permissionário deverá apresentar o projeto do evento com o layout, incluindo os pontos de iluminação, para que seja atestada a necessidade de ser utilizado ou não gerador. Caso seja atestada a necessidade, o permissionário deverá arcar com o aluguel de um gerador externo para não sobrecarregar a rede elétrica do Centro de Inovação do Jaraguá, de modo a evitar danos à estrutura.',
      '5.15 - Toda estrutura que não for retirada no dia da desmontagem que consta neste termo de permissão de uso será destinada a outros fins, bem como será aplicada multa no valor de 10% da locação.',
      '5.16 - É vedada a utilização da porta de emergência para fins que não seja de segurança, tais como movimentação de estrutura de eventos, sob pena de multa em caso de desobediência.',
      '5.17 - É proibido o consumo de comidas/bebidas dentro do auditório ou do anfiteatro, de modo que havendo violação deverá ser aplicada multa de 10% do valor de locação, bem como deverá arcar com o valor de danos, caso tenha ocorrido.',
      '5.18 - É proibido som e/ou apresentação musical fora do auditório, sob pena de multa.'
    ].forEach(p => drawParagrafo(doc, p));

    // CLÁUSULA 6 – PENALIDADES
    drawClausula(doc, 'Cláusula Sexta – Das Penalidades');
    [
      '6.1 - O descumprimento das cláusulas ora pactuadas por qualquer das partes acarretará a incidência de multa equivalente a 10% (dez por cento) do valor da permissão, a ser paga pela parte que deu causa em favor da parte inocente.',
      '6.2 - O valor descrito no item anterior deverá ser corrigido com base no IPCA do período correspondente, montante sobre o qual incidirão juros moratórios de 1% (um por cento) ao mês, calculado pro rata die.',
      '6.3 - Na hipótese de rescisão ocasionada pelo(a) PERMISSIONÁRIO(A) por desistência ou cancelamento do evento até os 30 (trinta) dias de antecedência o permissionário deverá ser penalizado com a perda da taxa de reserva mais multa de 20% (vinte por cento) sobre o valor do presente termo.',
      '6.4 - Em caso de violação das normas previstas neste contrato e no regimento interno, e havendo inadimplemento da multa aplicada e/ou ausência de manifestação por parte do permissionário, este poderá ser impedido de realizar reservas dos espaços por até 2 (dois) anos, contados a partir da data da notificação.'
    ].forEach(p => drawParagrafo(doc, p));

    // CLÁUSULA 7 – RESCISÃO
    drawClausula(doc, 'Cláusula Sétima – Da Rescisão');
    [
      '7.1 - A inexecução total ou parcial deste termo poderá acarretar em sanções administrativas, conforme disposto nos artigos 104, 137, 138 e 139 da Lei nº 14.133/2021.',
      '7.2 – O presente instrumento poderá ser rescindido a qualquer tempo pelo(a) PERMISSIONÁRIO(A), com notificação prévia de, no mínimo, 30 (trinta) dias (para eventos particulares) e 90 (noventa) dias (para eventos públicos) antes da data originalmente agendada para o evento, devidamente protocolada na Secretaria Estadual da Ciência, da Tecnologia e da Inovação de Alagoas – SECTI.',
      '7.2.1 – O não cumprimento do prazo mínimo de notificação impede a realização da alteração de data, sendo considerada desistência definitiva, sujeita às penalidades previstas neste instrumento.',
      '7.2.2 – Nessa hipótese, o(a) PERMISSIONÁRIO(A) terá o direito de realizar o evento em nova data, desde que dentro do prazo máximo de 01 (um) ano a contar da data da assinatura do primeiro termo de permissão de uso, ficando desde já estabelecido que a alteração poderá ocorrer uma única vez, estando a nova data condicionada à disponibilidade de pauta. Caso não haja disponibilidade dentro desse período ou se o evento não for realizado na nova data agendada, o(a) PERMISSIONÁRIO(A) perderá integralmente os valores já pagos.',
      '7.3 - Ocorrerá a rescisão do presente termo de permissão, independente de qualquer comunicação prévia ou indenização por parte da PERMITENTE, havendo qualquer sinistro, incêndio ou algo que venha impossibilitar a posse do espaço, independente de dolo ou culpa do PERMITENTE.',
      '7.4 - Os casos de rescisão devem ser formalmente motivados nos autos do processo, assegurado o contraditório e a ampla defesa.'
    ].forEach(p => drawParagrafo(doc, p));

    // CLÁUSULA 8 – OMISSÕES
    drawClausula(doc, 'Cláusula Oitava – Omissões Contratuais');
    drawParagrafo(doc, '8.1 - Os casos omissos serão decididos pela PERMITENTE segundo as disposições contidas na Lei nº 14.133/2021, e nas demais normas de licitações e contratos administrativos, além de, subsidiariamente, as disposições contidas na Lei nº 8.078/90 – Código de Defesa do Consumidor, e normas e princípios gerais dos contratos.');

    // CLÁUSULA 9 – FORO
    drawClausula(doc, 'Cláusula Nona – Do Foro');
    drawParagrafo(doc, '9.1 - As questões decorrentes da execução deste Instrumento que não possam ser dirimidas administrativamente serão processadas e julgadas no Foro da Cidade de Maceió – AL, que prevalecerá sobre qualquer outro, por mais privilegiado que seja, para dirimir quaisquer dúvidas oriundas do presente Termo.');

    // Fecho
    drawParagrafo(doc, `Para firmeza e validade do que foi pactuado, lavra-se o presente instrumento em 3 (três) vias de igual teor e forma, para que surtam um só efeito, as quais, depois de lidas, são assinadas pelas partes e pelas testemunhas abaixo.`);
    drawParagrafo(doc, `${cidadeUfDefault}, ${fmtDataExtenso(new Date().toISOString())}.`);

    // Assinaturas
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const linha = (rotulo) => {
      doc.moveDown(3);
      const y0 = doc.y;
      doc.moveTo(doc.page.margins.left, y0).lineTo(doc.page.margins.left + largura, y0).stroke();
      doc.moveDown(0.2);
      doc.font('Times-Roman').fontSize(11).text(rotulo, { width: largura, align: 'center' });
    };
    linha('PERMITENTE');
    linha('PERMISSIONÁRIA');
    linha('TESTEMUNHA – CPF Nº');
    linha('TESTEMUNHA – CPF Nº');

    // ===== 4) Paginação (rodapé) =====
    const range = doc.bufferedPageRange(); // {start, count}
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawHeader(doc);
      drawFooter(doc, i + 1, range.count);
    }

    // Finaliza e grava
    doc.end();

    // indexa/atualiza em `documentos` (UPSERT por evento+tipo)
    const createdAt = new Date().toISOString();
    const publicUrl = `/documentos/${fileName}`;
    await dbRun(
      `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url, status, created_at)
       VALUES ('termo_evento', NULL, NULL, ?, ?, ?, 'gerado', ?)
       ON CONFLICT(evento_id, tipo) DO UPDATE SET
         pdf_url = excluded.pdf_url,
         pdf_public_url = excluded.pdf_public_url,
         status = 'gerado',
         created_at = excluded.created_at`,
      [id, filePath, publicUrl, createdAt],
      'termo/upsert-documento'
    );

    // encerra o stream de arquivo
    writeStream.on('finish', () => console.log('[termo] PDF gravado em', filePath));
  } catch (err) {
    console.error('[admin/eventos] termo erro:', err);
    res.status(500).json({ error: 'Falha ao gerar termo' });
  }
});

/**
 * (Opcional) Disponibiliza metadados/URL pública já gerada
 */
router.post('/:eventoId/termo/disponibilizar', async (req, res) => {
  try {
    // Aqui, como o GET /:id/termo já gera e indexa, poderíamos apenas consultar o último registro.
    const { eventoId } = req.params;
    await ensureDocumentosSchema();
    const docRow = await dbGet(
      `SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
      [eventoId],
      'termo/get-doc-row'
    );
    if (!docRow) return res.status(404).json({ ok: false, error: 'Nenhum termo gerado ainda.' });
    return res.json({
      ok: true,
      documentoId: docRow.id,
      pdf_url: docRow.pdf_public_url,
      url_visualizacao: docRow.pdf_public_url
    });
  } catch (err) {
    console.error('[admin disponibilizar termo] erro:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao disponibilizar termo.' });
  }
});

/**
 * DELETE /api/admin/eventos/:eventoId -> apaga evento + DARs
 */
router.delete('/:eventoId', async (req, res) => {
  const { eventoId } = req.params;
  console.log(`[ADMIN] Apagar evento ID: ${eventoId}`);

  try {
    await dbRun('BEGIN TRANSACTION', [], 'apagar/BEGIN');

    const darsRows = await dbAll('SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/listar-vinculos');
    const darIds = darsRows.map(r => r.id_dar);

    await dbRun('DELETE FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/delete-join');

    if (darIds.length) {
      const placeholders = darIds.map(() => '?').join(',');
      await dbRun(`DELETE FROM dars WHERE id IN (${placeholders})`, darIds, 'apagar/delete-dars');
    }

    const result = await dbRun('DELETE FROM Eventos WHERE id = ?', [eventoId], 'apagar/delete-evento');
    if (!result.changes) throw new Error('Nenhum evento encontrado com este ID.');

    await dbRun('COMMIT', [], 'apagar/COMMIT');

    console.log(`[ADMIN] Evento ${eventoId} e ${darIds.length} DARs apagados.`);
    res.status(200).json({ message: 'Evento e DARs associadas apagados com sucesso!' });
  } catch (err) {
    try { await dbRun('ROLLBACK', [], 'apagar/ROLLBACK'); } catch {}
    console.error(`[ERRO] Ao apagar evento ID ${eventoId}:`, err.message);
    res.status(500).json({ error: 'Falha ao apagar o evento.' });
  }
});

module.exports = router;
