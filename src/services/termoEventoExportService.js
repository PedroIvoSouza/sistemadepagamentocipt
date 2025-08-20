// src/services/termoEventoExportService.js
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// ------------------------------
// Helpers Promissificados (DB)
// ------------------------------
const dbGet = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row))));
const dbAll = (sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows))));
const dbRun = (sql, params = []) =>
  new Promise((res, rej) =>
    db.run(sql, params, function (e) {
      return e ? rej(e) : res(this);
    })
  );

// ------------------------------
// Formatadores / utils
// ------------------------------
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

function sanitizeForFilename(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/["'`]/g, '')                           // remove aspas
    .replace(/[\/\\]+/g, '-')                        // barras -> hífen
    .replace(/[^\w.\-]+/g, '_')                      // demais não-alfanum -> _
    .replace(/_{2,}/g, '_')                          // compacta __
    .replace(/^_+|_+$/g, '');                        // tira _ das pontas
}

function firstDateFromDatas(datas) {
  if (!datas) return 's-d';
  const raw = String(datas).trim();
  let first = '';
  // tenta JSON: ["2025-09-15", ...]
  try {
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) first = arr[0];
    }
  } catch {}
  // fallback CSV: 2025-09-15,2025-09-16
  if (!first) first = raw.split(',')[0] || '';
  return String(first).replace(/[^\d\-]/g, ''); // mantém só YYYY-MM-DD
}

const fmtMoeda = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n || 0));

const fmtArea = (n) => {
  const num = Number(n || 0);
  return num
    ? `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`
    : '-';
};

const fmtDataExtenso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
};

const mkPeriodo = (datas_evento) => {
  if (!datas_evento) return '';
  const arr = String(datas_evento)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!arr.length) return '';
  const ext = arr.map(fmtDataExtenso);
  return ext.length === 1 ? ext[0] : `${ext[0]} a ${ext[ext.length - 1]}`;
};

// -------------------------------------------------
// MIGRAÇÃO/garantia do schema da tabela `documentos`
// -------------------------------------------------
async function ensureDocumentosSchema() {
  // base mínima
  await dbRun(
    `CREATE TABLE IF NOT EXISTS documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      token TEXT UNIQUE
    )`
  );

  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const names = new Set(cols.map((c) => c.name));
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

  // Índice único por (evento_id, tipo) — garante 1 termo por evento/tipo.
  // Se precisar permitir múltiplos termos, mude para INDEX sem UNIQUE.
  await dbRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`
  ).catch(() => {});
}

// ---------------------------------------------
// Carrega e compila o HTML do template público
// ---------------------------------------------
function compileHtmlTemplate(payload) {
  // ATENÇÃO: o arquivo foi passado como "termo-permisao.html" (sem o segundo 's')
  const templatePath = path.resolve(process.cwd(), 'public', 'termo-permisao.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template não encontrado: ${templatePath}`);
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Se o template usa <img src="images/papel-timbrado-secti.png">,
  // converte para caminho absoluto file:// para o Chromium carregar
  const imgRel = /src=["']images\/papel-timbrado-secti\.png["']/i;
  if (imgRel.test(html)) {
    const imgAbs = path
      .resolve(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png')
      .replace(/\\/g, '/');
    html = html.replace(imgRel, `src="file://${imgAbs}"`);
  }

  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(payload);
}

// ----------------------
// Gera PDF com Puppeteer
// ----------------------
async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '1in', right: '1in', bottom: '1in', left: '1in' }
  });
  await browser.close();
  return pdf;
}

// --------------------------------------------
// Monta o payload completo a partir do Evento
// --------------------------------------------
async function buildPayloadFromEvento(eventoId) {
  // Evento + Cliente
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.email, c.telefone, c.endereco,
            c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  // Parcelas (DARs vinculadas)
  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`,
    [eventoId]
  );

  // Derivações
  const periodo = mkPeriodo(ev.datas_evento);
  const datasArr = String(ev.datas_evento || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const primeiraData = datasArr[0] || null;

  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
  const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;

  const sinal = parcelas[0]?.data_vencimento || null;
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  // Permitente (via .env)
  const permitenteRazao = process.env.PERMITENTE_RAZAO ||
    'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj = process.env.PERMITENTE_CNPJ || '04.007.216/0001-30';
  const permitenteEnd =
    process.env.PERMITENTE_ENDERECO ||
    'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf = process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  // Órgão (cabeçalho)
  const orgUF = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  // Placeholders do template
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
    local_espaco: ev.espaco_utilizado || 'AUDITÓRIO',
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

  // (Compat) placeholders antigos usados no HTML simplificado
  const payloadCompat = {
    processo: ev.numero_processo || '',
    evento: ev.nome_evento || '',
    periodo: periodo || fmtDataExtenso(primeiraData)
  };

  return { ...payloadTermo, ...payloadCompat };
}

// --------------------------------------
// Nome do arquivo (sanitizado e robusto)
// --------------------------------------
function nomeArquivo(ev, idDoc) {
  const razao = sanitizeForFilename(ev?.nome_razao_social || 'Cliente');
  const termo = sanitizeForFilename(ev?.numero_termo || 's-n'); // ex.: 042-2025 (sem '/')
  const dataPrimeira = firstDateFromDatas(ev?.datas_evento);    // ex.: 2025-09-15
  return `TermoPermissao_${termo}_${razao}_Data-${dataPrimeira || 's-d'}_${idDoc}.pdf`;
}

// ------------------------------------------------------
// Salva o PDF no disco e registra em `documentos`
// ------------------------------------------------------
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
  await dbRun(`UPDATE documentos SET pdf_url = ?, pdf_public_url = ? WHERE id = ?`, [
    filePath,
    publicUrl,
    documentoId
  ]);

  return { documentoId, token, filePath, fileName, publicUrl };
}

// ------------------------------------------------------
// API principal: gera termo e indexa em `documentos`
// ------------------------------------------------------
async function gerarTermoEventoEIndexar(eventoId) {
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  const payload = await buildPayloadFromEvento(eventoId);
  const html = compileHtmlTemplate(payload);
  const pdfBuf = await htmlToPdfBuffer(html);

  const doc = await salvarDocumentoRegistro(pdfBuf, 'termo_evento', null, eventoId, ev);

  // Página pública (com botão de assinatura via Assinafy embed)
  const urlTermoPublic = `/eventos/termo.html?id=${doc.documentoId}`;

  return { ...doc, pdf_public_url: doc.publicUrl, urlTermoPublic };
}

module.exports = { gerarTermoEventoEIndexar };
