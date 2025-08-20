const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// helpers promissificados
const dbGet = (sql, params=[]) => new Promise((res, rej)=> db.get(sql, params, (e, row)=> e?rej(e):res(row)));
const dbAll = (sql, params=[]) => new Promise((res, rej)=> db.all(sql, params, (e, rows)=> e?rej(e):res(rows)));
const dbRun = (sql, params=[]) => new Promise((res, rej)=> db.run(sql, params, function(e){ e?rej(e):res(this); }));

// ---------- utils de formatação ----------
const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n||0));
const fmtDataExtenso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
};

// Monta string de período a partir de datas_evento (se vier como "YYYY-MM-DD,YYYY-MM-DD,...")
function periodoEvento(datas_evento) {
  if (!datas_evento) return '';
  const arr = String(datas_evento).split(',').map(s=>s.trim()).filter(Boolean);
  if (!arr.length) return '';
  const ext = arr.map(fmtDataExtenso);
  return ext.length === 1 ? ext[0] : `${ext[0]} a ${ext[ext.length-1]}`;
}

// Garante tabela 'documentos' com campos necessários
async function ensureDocumentosTable() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,                 -- 'termo_evento'
    token TEXT UNIQUE,
    permissionario_id INTEGER,
    evento_id INTEGER,
    pdf_url TEXT,                       -- caminho físico no servidor
    pdf_public_url TEXT,                -- URL pública (ex: /documentos/xxx.pdf)
    assinafy_id TEXT,
    status TEXT DEFAULT 'gerado',       -- 'gerado' | 'enviado' | 'assinado'
    signed_pdf_public_url TEXT,         -- URL pública do PDF assinado
    signed_at TEXT,
    signer TEXT,
    created_at TEXT
  )`);
  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo
               ON documentos(evento_id, tipo)`);
}

// Lê o template HTML público e ajusta assets para caminho absoluto file://
function compileHtmlTemplate(payload) {
  // OBS: seu arquivo está como "public/termo-permisao.html" (sem o segundo 's').
  const templatePath = path.resolve(process.cwd(), 'public', 'termo-permisao.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template não encontrado: ${templatePath}`);
  }
  let html = fs.readFileSync(templatePath, 'utf8');

  // Corrige caminho do timbrado para caminho absoluto (Chromium no server)
  const imgRel = /src=["']images\/papel-timbrado-secti\.png["']/i;
  const imgAbs = path.resolve(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png')
    .replace(/\\/g, '/');
  html = html.replace(imgRel, `src="file://${imgAbs}"`);

  // Compila com Handlebars
  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(payload);
}

async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top:'1in', right:'1in', bottom:'1in', left:'1in' }
  });
  await browser.close();
  return pdf;
}

// Monta payload a partir das tabelas Eventos + Clientes_Eventos + parcelas (DARs)
async function buildPayloadFromEvento(eventoId) {
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.email, c.telefone, c.endereco,
            c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`, [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`, [eventoId]
  );

  const periodo = periodoEvento(ev.datas_evento);
  const cronograma = parcelas.map(p =>
    `${p.numero_parcela}ª parcela em ${fmtDataExtenso(p.data_vencimento)} - ${fmtMoeda(p.valor_parcela)}`
  ).join('; ');

  // Placeholders do seu HTML
  const payloadBasico = {
    processo: ev.numero_processo || '',
    evento: ev.nome_evento || '',
    periodo: periodo || fmtDataExtenso((String(ev.datas_evento||'').split(',')[0] || '').trim()),
  };

  // Campos extras para caso evolua o template
  const payloadEstendido = {
    numero_processo: ev.numero_processo || '',
    numero_termo: ev.numero_termo || '',
    permissionario_nome: ev.nome_razao_social || '',
    permissionario_documento: ev.documento || '',
    clausula1: `Área: ${ev.area_m2 || '-'} m², Evento: ${ev.nome_evento || '-'}, Período: ${periodo || '-'},
                Horário: ${ev.hora_inicio || '-'}-${ev.hora_fim || '-'}, Ofício SEI: ${ev.numero_oficio_sei || '-'}`,
    tabela_linha: `${ev.area_m2 || '-'};${ev.total_diarias || '-'};${fmtMoeda(ev.valor_final)}`,
    pagamentos: cronograma,
    vigencia_fim_datahora: fmtDataExtenso(ev.data_vigencia_final),
    pagto_sinal_data: '',
    pagto_saldo_data: '',
    assinatura_data: fmtDataExtenso(new Date().toISOString()),
  };

  return { ...payloadEstendido, ...payloadBasico };
}

function nomeArquivo(ev, idDoc) {
  const razao = (ev?.nome_razao_social || 'Cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'_');
  const dataPrimeira = (String(ev?.datas_evento||'').split(',')[0]||'').trim();
  return `TermoPermissao_${ev?.numero_termo || 's-n'}_${razao}_Data-${dataPrimeira || 's-d'}_${idDoc}.pdf`;
}

async function salvarDocumentoRegistro(buffer, tipo, permissionarioId, eventoId, evRow) {
  await ensureDocumentosTable();

  // diretório público para servir estático
  const dir = path.resolve(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(dir, { recursive: true });

  // cria entrada na tabela para obter id e token
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const createdAt = new Date().toISOString();
  const ins = await dbRun(
    `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, status, created_at)
     VALUES (?, ?, ?, ?, 'gerado', ?)`,
     [tipo, token, permissionarioId || null, eventoId || null, createdAt]
  );
  const documentoId = ins.lastID;

  // salva PDF e registra URLs
  const fileName = nomeArquivo(evRow, documentoId);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);

  const publicUrl = `/documentos/${fileName}`;
  await dbRun(`UPDATE documentos SET pdf_url = ?, pdf_public_url = ? WHERE id = ?`,
              [filePath, publicUrl, documentoId]);

  return { documentoId, token, filePath, fileName, publicUrl };
}

/**
 * Gera o PDF do termo para um Evento e indexa em 'documentos'.
 * Retorna { documentoId, token, filePath, fileName, pdf_public_url, urlTermoPublic }.
 */
async function gerarTermoEventoEIndexar(eventoId) {
  const ev = await dbGet(`SELECT e.*, c.nome_razao_social
                            FROM Eventos e JOIN Clientes_Eventos c ON c.id=e.id_cliente
                           WHERE e.id=?`, [eventoId]);
  if (!ev) throw new Error('Evento não encontrado');

  const payload = await buildPayloadFromEvento(eventoId);
  const html = compileHtmlTemplate(payload);
  const pdfBuf = await htmlToPdfBuffer(html);

  const doc = await salvarDocumentoRegistro(
    pdfBuf,
    'termo_evento',
    null,      // permissionario_id (não se aplica aqui)
    eventoId,
    ev
  );

  // página pública de assinatura que você já tem
  const urlTermoPublic = `/eventos/termo.html?id=${doc.documentoId}`;

  return { ...doc, pdf_public_url: doc.publicUrl, urlTermoPublic };
}

module.exports = { gerarTermoEventoEIndexar };
