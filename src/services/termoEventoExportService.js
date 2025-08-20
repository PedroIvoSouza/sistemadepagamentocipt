// src/services/termoEventoExportService.js
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// --- helpers sqlite promisificados ---
const dbGet = (sql, params=[]) => new Promise((res, rej)=> db.get(sql, params, (e, row)=> e?rej(e):res(row)));
const dbAll = (sql, params=[]) => new Promise((res, rej)=> db.all(sql, params, (e, rows)=> e?rej(e):res(rows)));
const dbRun = (sql, params=[]) => new Promise((res, rej)=> db.run(sql, params, function(e){ e?rej(e):res(this); }));

// ---------- utils ----------
const onlyDigits = (v='') => String(v).replace(/\D/g,'');
const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n||0));
const fmtArea  = (n) => {
  const num = Number(n || 0);
  return num ? `${num.toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2})} m²` : '-';
};
const fmtDataExtenso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
};
const mkPeriodo = (datas_evento) => {
  if (!datas_evento) return '';
  const arr = String(datas_evento).split(',').map(s=>s.trim()).filter(Boolean);
  if (!arr.length) return '';
  const ext = arr.map(fmtDataExtenso);
  return ext.length === 1 ? ext[0] : `${ext[0]} a ${ext[ext.length-1]}`;
};

// --------- MIGRAÇÃO DA TABELA `documentos` (auto) ---------
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

  try {
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
  } catch {}
}

// --- compila HTML do template + força caminho absoluto do timbrado ---
function compileHtmlTemplate(payload) {
  const templatePath = path.resolve(process.cwd(), 'public', 'termo-permisao.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template não encontrado: ${templatePath}`);
  }
  let html = fs.readFileSync(templatePath, 'utf8');

  // Força o PNG do timbrado como file:// absoluto (funciona no Chromium headless)
  const abs = path
    .resolve(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png')
    .replace(/\\/g, '/');

  // casos: <img src="/images/...">, <img src="images/...">, CSS url('/images/...')
  html = html
    .replace(/src=["']\/?images\/papel-timbrado-secti\.png["']/gi, `src="file://${abs}"`)
    .replace(/url\((['"]?)\/?images\/papel-timbrado-secti\.png\1\)/gi, `url("file://${abs}")`);

  // Garante um pequeno CSS de segurança (se não existir) p/ repetir header/footer
  if (!/\.letterhead/.test(html)) {
    const safetyCss = `
<style>
  /* Segurança: garante timbrado repetindo em todas as páginas */
  .letterhead { position: fixed; left: 0; top: 0; right:0; bottom:0; z-index:-1; }
  .letterhead img { position: fixed; left:0; top:0; width: 210mm; height: 297mm; }
  /* Margens do conteúdo (ajuste se necessário) */
  body{ margin: 25mm 25mm 25mm 25mm; }
  /* Parágrafo introdutório com margem de 6cm e texto justificado */
  .intro-justify { margin-left: 6cm; text-align: justify; }
</style>`;
    html = html.replace('</head>', `${safetyCss}\n</head>`);
  }

  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(payload);
}

// --- HTML -> PDF (com fundo/timbrado renderizado) ---
async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true, // IMPORTANTE p/ timbrado
    margin: { top:'1in', right:'1in', bottom:'1in', left:'1in' } // ~2,54 cm
  });

  await browser.close();
  return pdf;
}

// --- monta payload a partir do evento/cliente/DARs ---
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

  const periodo = mkPeriodo(ev.datas_evento);
  const datasArr = String(ev.datas_evento||'').split(',').map(s=>s.trim()).filter(Boolean);
  const primeiraData = datasArr[0] || null;
  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
  const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;

  const sinal = parcelas[0]?.data_vencimento || null;
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  // Permitente via .env
  const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj  = process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30';
  const permitenteEnd   = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf= process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  // Cabeçalho do órgão (se quiser usar no template)
  const orgUF  = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  const payloadTermo = {
    // Cabeçalho
    org_uf: orgUF,
    org_secretaria: orgSec,
    org_unidade: orgUni,

    processo_numero: ev.numero_processo || '',
    termo_numero: ev.numero_termo || '',

    // Permitente
    permitente_razao: permitenteRazao,
    permitente_cnpj: permitenteCnpj,
    permitente_endereco: permitenteEnd,
    permitente_representante_nome: permitenteRepNm,
    permitente_representante_cargo: permitenteRepCg,
    permitente_representante_cpf: permitenteRepCpf,

    // Permissionário
    permissionario_razao: ev.nome_razao_social || '',
    permissionario_cnpj: onlyDigits(ev.documento || ''),
    permissionario_endereco: ev.endereco || '',
    permissionario_representante_nome: ev.nome_responsavel || '',
    permissionario_representante_cpf: onlyDigits(ev.documento_responsavel || ''),

    // Evento
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
      ? `${new Date(ev.data_vigencia_final+'T12:00:00').toLocaleDateString('pt-BR')} às 12h`
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

  // compat com placeholders antigos
  const payloadCompat = {
    processo: ev.numero_processo || '',
    evento: ev.nome_evento || '',
    periodo: periodo || fmtDataExtenso(primeiraData)
  };

  return { ...payloadTermo, ...payloadCompat };
}

// --- nome do arquivo ---
function nomeArquivo(ev, idDoc) {
  const razao = (ev?.nome_razao_social || 'Cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'_');
  const dataPrimeira = (String(ev?.datas_evento||'').split(',')[0]||'').trim();
  return `TermoPermissao_${ev?.numero_termo || 's-n'}_${razao}_Data-${dataPrimeira || 's-d'}_${idDoc}.pdf`;
}

// --- salva (com UPSERT de verdade p/ não estourar UNIQUE) ---
async function salvarDocumentoRegistro(buffer, tipo, permissionarioId, eventoId, evRow) {
  await ensureDocumentosSchema();

  const dir = path.resolve(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(dir, { recursive: true });

  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const createdAt = new Date().toISOString();

  // tenta INSERT; se conflitar em (evento_id, tipo), faz UPDATE (UPSERT manual)
  let documentoId;
  try {
    const ins = await dbRun(
      `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, status, created_at)
       VALUES (?, ?, ?, ?, 'gerado', ?)`,
      [tipo, token, permissionarioId || null, eventoId || null, createdAt]
    );
    documentoId = ins.lastID;
  } catch (e) {
    const isUnique = /UNIQUE\s+constraint\s+failed:\s*documentos\.evento_id,\s*documentos\.tipo/i.test(String(e && e.message));
    if (!isUnique) throw e;
    const row = await dbGet(`SELECT id FROM documentos WHERE evento_id=? AND tipo=?`, [eventoId, tipo]);
    documentoId = row?.id;
    if (!documentoId) throw e; // algo muito errado
    await dbRun(`UPDATE documentos SET token=?, status='gerado', created_at=? WHERE id=?`,
                [token, createdAt, documentoId]);
  }

  const fileName = nomeArquivo(evRow, documentoId);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);

  const publicUrl = `/documentos/${fileName}`;
  await dbRun(`UPDATE documentos SET pdf_url=?, pdf_public_url=? WHERE id=?`,
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
    null,
    eventoId,
    ev
  );

  const urlTermoPublic = `/eventos/termo.html?id=${doc.documentoId}`;
  return { ...doc, pdf_public_url: doc.publicUrl, urlTermoPublic };
}

module.exports = { gerarTermoEventoEIndexar };
