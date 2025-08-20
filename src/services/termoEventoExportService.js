// src/services/termoEventoExportService.js
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// ---------- SQLite helpers ----------
const dbGet = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function (e) { e ? rej(e) : res(this); })
);

// ---------- utils ----------
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
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
const mkPeriodo = (datas_evento) => {
  if (!datas_evento) return '';
  const raw = String(datas_evento).trim();
  let arr;
  try {
    arr = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map(s => s.trim()).filter(Boolean);
  } catch {
    arr = raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!arr.length) return '';
  const ext = arr.map(fmtDataExtenso);
  return ext.length === 1 ? ext[0] : `${ext[0]} a ${ext[ext.length - 1]}`;
};

function sanitizeForFilename(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/["'`]/g, '')
    .replace(/[\/\\]+/g, '-')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

// --------- MIGRA: tabela `documentos` (garante colunas) ---------
async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`);

  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const names = new Set(cols.map(c => c.name));
  const addIfMissing = async (name, def) => {
    if (!names.has(name)) {
      await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`);
      names.add(name);
    }
  };

  await addIfMissing('permissionario_id', 'INTEGER');
  await addIfMissing('evento_id', 'INTEGER');
  await addIfMissing('pdf_url', 'TEXT');
  await addIfMissing('pdf_public_url', 'TEXT');
  await addIfMissing('assinafy_id', 'TEXT');
  await addIfMissing('status', "TEXT DEFAULT 'gerado'");
  await addIfMissing('signed_pdf_public_url', 'TEXT');
  await addIfMissing('signed_at', 'TEXT');
  await addIfMissing('signer', 'TEXT');
  await addIfMissing('created_at', 'TEXT');

  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
}

// ---------- Template HTML ----------
function compileHtmlTemplate(payload) {
  const templatePath = path.resolve(process.cwd(), 'public', 'termo-permisao.html'); // nome do seu HTML
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template não encontrado: ${templatePath}`);
  }
  const html = fs.readFileSync(templatePath, 'utf8');
  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(payload);
}

// Injeta timbrado como background full-page e aplica margens via padding
function injectLetterheadAndMargins(html) {
  const imgPath = path.resolve(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png');
  let bgBlock = '';
  if (fs.existsSync(imgPath)) {
    const b64 = fs.readFileSync(imgPath).toString('base64');
    bgBlock = `
      <div class="__bg-letterhead"><img src="data:image/png;base64,${b64}" alt=""></div>
    `;
  } else {
    console.warn('[termoEvento] Timbrado não encontrado em:', imgPath);
  }

  const styles = `
    <style>
      /* Sem margens do PDF: usamos padding para recriar as ABNT (~2,5cm) */
      :root { --m: 2.5cm; }
      @page { size: A4; margin: 0; }
      html, body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .__bg-letterhead {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        z-index: 0; pointer-events: none;
      }
      .__bg-letterhead img {
        width: 100%; height: 100%; object-fit: cover;
      }
      .__page-wrap {
        position: relative; z-index: 1;
        padding: var(--m);
      }
    </style>
  `;

  // garante wrapper do conteúdo
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, '<body$1><div class="__page-wrap">');
    html = html.replace(/<\/body>/i, `</div></body>`);
  } else {
    html = `<div class="__page-wrap">${html}</div>`;
  }

  // injeta CSS e o background antes de fechar o body
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${styles}</head>`);
  } else {
    html = `${styles}${html}`;
  }
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${bgBlock}</body>`);
  } else {
    html = `${html}${bgBlock}`;
  }
  return html;
}

// ---------- HTML -> PDF ----------
async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // injeta timbrado e margens por CSS (PDF sem header/footer do Chrome)
  const htmlFinal = injectLetterheadAndMargins(html);
  await page.setContent(htmlFinal, { waitUntil: 'networkidle0' });

  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: false, // importante!
    margin: { top: 0, right: 0, bottom: 0, left: 0 } // sem margens no PDF
  });

  await browser.close();
  return pdf;
}

// ---------- Payload (placeholders) ----------
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

  // Datas
  const rawDatas = String(ev.datas_evento || '').trim();
  let datasArr;
  try {
    datasArr = rawDatas.startsWith('[') ? JSON.parse(rawDatas) : rawDatas.split(',').map(s => s.trim()).filter(Boolean);
  } catch {
    datasArr = rawDatas.split(',').map(s => s.trim()).filter(Boolean);
  }
  const primeiraData = datasArr[0] || null;

  // Defaults / .env
  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
  const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;

  const sinal = parcelas[0]?.data_vencimento || null;
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  // Permitente (.env)
  const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj = process.env.PERMITENTE_CNPJ || '04.007.216/0001-30';
  const permitenteEnd = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf = process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  // Órgão (cabeçalho)
  const orgUF = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  const payloadTermo = {
    org_uf: orgUF,
    org_secretaria: orgSec,
    org_unidade: orgUni,

    processo_numero: ev.numero_processo || '',
    termo_numero: ev.numero_termo || '',

    permitente_razao: permitenteRazao,
    permitente_cnpj: permitenteCnpj,
    permitente_endereco: permitenteEnd,
    permitente_representante_nome: permitenteRepNm,
    permitente_representante_cargo: permitenteRepCg,
    permitente_representante_cpf: permitenteRepCpf,

    permissionario_razao: ev.nome_razao_social || '',
    permissionario_cnpj: onlyDigits(ev.documento || ''),
    permissionario_endereco: ev.endereco || '',
    permissionario_representante_nome: ev.nome_responsavel || '',
    permissionario_representante_cpf: onlyDigits(ev.documento_responsavel || ''),

    evento_titulo: ev.nome_evento || '',
    local_espaco: ev.espaco_utilizado || 'Auditório',
    imovel_nome: imovelNome,

    data_evento: fmtDataExtenso(primeiraData),
    hora_inicio: ev.hora_inicio || '-',
    hora_fim: ev.hora_fim || '-',
    data_montagem: fmtDataExtenso(primeiraData),
    data_desmontagem: fmtDataExtenso(primeiraData),

    area_m2: ev.area_m2 || null,
    area_m2_fmt: fmtArea(ev.area_m2),
    capacidade_pessoas: capDefault,

    numero_dias: ev.total_diarias || (datasArr.length || 1),
    valor_total: ev.valor_final || 0,
    valor_total_fmt: fmtMoeda(ev.valor_final || 0),

    vigencia_fim_datahora: ev.data_vigencia_final
      ? `${new Date(ev.data_vigencia_final + 'T12:00:00').toLocaleDateString('pt-BR')} às 12h`
      : '',

    pagto_sinal_data: fmtDataExtenso(sinal),
    pagto_saldo_data: fmtDataExtenso(saldo),

    fundo_nome: fundoNome,

    cidade_uf: cidadeUfDefault,
    data_assinatura: fmtDataExtenso(new Date().toISOString()),

    assinante_permitente_rotulo: 'PERMITENTE',
    assinante_permissionaria_rotulo: 'PERMISSIONÁRIA',
    testemunha1_cpf: '',
    testemunha2_cpf: ''
  };

  // compat com placeholders simples do template curto
  const payloadCompat = {
    processo: ev.numero_processo || '',
    evento: ev.nome_evento || '',
    periodo: mkPeriodo(ev.datas_evento) || fmtDataExtenso(primeiraData)
  };

  return { ...payloadTermo, ...payloadCompat };
}

// ---------- Nome do arquivo ----------
function nomeArquivo(evRow, idDoc) {
  const razao = sanitizeForFilename(evRow?.nome_razao_social || 'Cliente');
  // primeira data robusta
  const raw = String(evRow?.datas_evento || '').trim();
  let primeira = '';
  try {
    const arr = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map(s => s.trim()).filter(Boolean);
    primeira = arr[0] || '';
  } catch { primeira = (raw.split(',')[0] || '').trim(); }
  const dataPart = primeira || 's-d';
  const termo = sanitizeForFilename(evRow?.numero_termo || 's-n');
  return `TermoPermissao_${termo}_${razao}_Data-${dataPart}_${idDoc}.pdf`;
}

// ---------- Persistência do PDF ----------
async function salvarDocumentoRegistro(buffer, tipo, permissionarioId, eventoId, evRow) {
  await ensureDocumentosSchema();

  const dir = path.resolve(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(dir, { recursive: true });

  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const createdAt = new Date().toISOString();

  const ins = await dbRun(
    `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, status, created_at)
     VALUES (?, ?, ?, ?, 'gerado', ?)`,
    [tipo, token, permissionarioId || null, eventoId || null, createdAt]
  );
  const documentoId = ins.lastID;

  const fileName = nomeArquivo(evRow, documentoId);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);

  const publicUrl = `/documentos/${fileName}`;
  await dbRun(
    `UPDATE documentos SET pdf_url = ?, pdf_public_url = ? WHERE id = ?`,
    [filePath, publicUrl, documentoId]
  );

  return { documentoId, token, filePath, fileName, publicUrl };
}

// ---------- Orquestração ----------
async function gerarTermoEventoEIndexar(eventoId) {
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social
       FROM Eventos e JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  const payload = await buildPayloadFromEvento(eventoId);
  const html = compileHtmlTemplate(payload);
  const pdfBuf = await htmlToPdfBuffer(html);

  const doc = await salvarDocumentoRegistro(
    pdfBuf,
    'termo_evento',
    null,
    eventoId,
    ev
  );

  const urlTermoPublic = `/eventos/termo.html?id=${doc.documentoId}`;
  return { ...doc, pdf_public_url: doc.publicUrl, urlTermoPublic };
}

module.exports = { gerarTermoEventoEIndexar };
