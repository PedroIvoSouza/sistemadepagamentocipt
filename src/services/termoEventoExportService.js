const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// Helpers promissificados
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

// ---------- utils ----------
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n || 0));
const fmtArea = (n) => {
  const num = Number(n || 0);
  return num ? `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²` : '-';
};
function parseLocalDateFlexible(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y && mo && d) return new Date(y, mo - 1, d);
  }
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) {
    const d = Number(br[1]), mo = Number(br[2]), y = Number(br[3]);
    if (y && mo && d) return new Date(y, mo - 1, d);
  }
  return null;
}
const fmtDataExtenso = (iso) => {
  const d = parseLocalDateFlexible(iso);
  return d
    ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    : '';
};
const mkPeriodo = (datas_evento) => {
  if (!datas_evento) return '';
  const arr = String(datas_evento).split(',').map(s => s.trim()).filter(Boolean);
  if (!arr.length) return '';
  const ext = arr.map(fmtDataExtenso);
  return ext.length === 1 ? ext[0] : `${ext[0]} a ${ext[ext.length - 1]}`;
};
const sanitizeForFilename = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
  .replace(/["'`]/g, '')                           // aspas
  .replace(/[\/\\]+/g, '-')                        // barras -> hífen
  .replace(/[^\w.\-]+/g, '_')                      // demais -> _
  .replace(/_{2,}/g, '_')                          // compacta
  .replace(/^_+|_+$/g, '');                        // trim _

function parseEspacos(v) {
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

function formatEspacos(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} e ${arr[arr.length - 1]}`;
}

// --------- MIGRAÇÃO DA TABELA `documentos` (auto) ---------
async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT,
    permissionario_id INTEGER,
    evento_id INTEGER,
    pdf_url TEXT,
    pdf_public_url TEXT,
    assinafy_id TEXT,
    status TEXT DEFAULT 'gerado',
    signed_pdf_public_url TEXT,
    signed_at TEXT,
    signer TEXT,
    created_at TEXT,
    versao INTEGER DEFAULT 1
  )`);
  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('versao')) {
    await dbRun(`ALTER TABLE documentos ADD COLUMN versao INTEGER DEFAULT 1`);
  }
  try {
    await dbRun(`UPDATE documentos SET versao = 1 WHERE versao IS NULL`);
    await dbRun(`DROP INDEX IF EXISTS ux_documentos_evento_tipo`);
    await dbRun(`DROP INDEX IF EXISTS idx_documentos_evento_tipo`);
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo_versao ON documentos(evento_id, tipo, versao)`);
  } catch (_) { /* ignore */ }
}

// Lê o template e injeta <base href="file:///.../public/">
function compileHtmlTemplate(payload) {
  // OBS: o arquivo se chama "termo-permisao.html" (sem 2º "s")
  const templatePath = path.resolve(process.cwd(), 'public', 'termo-permisao.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template não encontrado: ${templatePath}`);
  }
  let html = fs.readFileSync(templatePath, 'utf8');

  // Injeta <base> para que *toda* URL relativa (images/...) resolva no FS
  const publicDirAbs = path.resolve(process.cwd(), 'public').replace(/\\/g, '/');
  const baseTag = `<base href="file://${publicDirAbs}/">`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else {
    html = `${baseTag}${html}`;
  }

  // Compila com Handlebars (sem escapar para manter tags)
  const tpl = Handlebars.compile(html, { noEscape: true });
  return tpl(payload);
}

async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] /*, headless: 'new' */ });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: {
      // As margens “visuais” ficam no CSS pelo header/footer fixos;
      // aqui deixamos 0 para não “empurrar” o conteúdo.
      top: '0cm', right: '0cm', bottom: '0cm', left: '0cm'
    },
    preferCSSPageSize: true
  });
  await browser.close();
  return pdf;
}

// Monta payload completo a partir do Evento
async function buildPayloadFromEvento(eventoId) {
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.email, c.telefone, c.endereco,
            c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`, [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  // Parcelas (para datas de sinal/saldo)
  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`, [eventoId]
  );

  const datasArr = String(ev.datas_evento || '').split(',').map(s => s.trim()).filter(Boolean);
  const primeiraData = datasArr[0] || null;
  const ultimaData = datasArr[datasArr.length - 1] || null;

  // Variáveis de ambiente (permitente / cabeçalho)
  const orgUF = (process.env.ORG_UF || 'ESTADO DE ALAGOAS').toUpperCase();
  const orgSec = (process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO').toUpperCase();
  const orgUni = (process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ').toUpperCase();

  const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj = process.env.PERMITENTE_CNPJ || '04.007.216/0001-30';
  const permitenteEnd = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf = process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;
  const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';

  const sinal = parcelas[0]?.data_vencimento || null;
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  const vigenciaFim = parseLocalDateFlexible(ev.data_vigencia_final);

  const espacosArr = parseEspacos(ev.espaco_utilizado);
  const localEspaco = formatEspacos(espacosArr) || 'AUDITÓRIO';
  const espacosPlural = espacosArr.length > 1;

  // Payload p/ o template
  const payload = {
    // Cabeçalho do órgão
    org_uf: orgUF,
    org_secretaria: orgSec,
    org_unidade: orgUni,

    // Identificação
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
    local_espaco: localEspaco,
    espacos_plural: espacosPlural,
    imovel_nome: imovelNome,

    data_evento: mkPeriodo(ev.datas_evento),
    data_evento_iso: primeiraData || null,
    hora_inicio: ev.hora_inicio || '-',
    hora_fim: ev.hora_fim || '-',
    data_montagem: fmtDataExtenso(primeiraData),
    data_desmontagem: fmtDataExtenso(ultimaData),

    area_m2: ev.area_m2 || null,
    area_m2_fmt: fmtArea(ev.area_m2),
    capacidade_pessoas: capDefault,

    numero_dias: ev.total_diarias || (datasArr.length || 1),
    valor_total: ev.valor_final || 0,
    valor_total_fmt: fmtMoeda(ev.valor_final || 0),

    vigencia_fim_datahora: vigenciaFim
      ? `${vigenciaFim.toLocaleDateString('pt-BR')} às 12h`
      : '',

    pagto_sinal_data: fmtDataExtenso(sinal),
    pagto_saldo_data: fmtDataExtenso(saldo),

    fundo_nome: fundoNome,
    cidade_uf: cidadeUfDefault,
    data_assinatura: fmtDataExtenso(new Date().toISOString()),

    assinante_permitente_rotulo: 'PERMITENTE',
    assinante_permissionaria_rotulo: 'PERMISSIONÁRIA',
    testemunha1_cpf: '',
    testemunha2_cpf: '',

    // Compat antigo (se tiver algo legado lendo):
    processo: ev.numero_processo || '',
    evento: ev.nome_evento || '',
    periodo: mkPeriodo(ev.datas_evento) || fmtDataExtenso(primeiraData)
  };

  return payload;
}

// Nome de arquivo robusto (sem barras etc.)
function nomeArquivo(evRow, idDoc) {
  const razao = sanitizeForFilename(evRow?.nome_razao_social || 'Cliente');
  const termo = sanitizeForFilename(evRow?.numero_termo || 's-n'); // evita "042/2025"
  const dataPrimeira = sanitizeForFilename((String(evRow?.datas_evento || '').split(',')[0] || '').trim() || 's-d');
  return `TermoPermissao_${termo}_${razao}_Data-${dataPrimeira}_${idDoc}.pdf`;
}

// Upsert do registro em `documentos` e gravação do PDF
async function salvarDocumentoRegistro(buffer, tipo, permissionarioId, eventoId, evRow) {
  await ensureDocumentosSchema();

  const dir = path.resolve(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(dir, { recursive: true });

  // Verifica se já existe documento do mesmo evento/tipo
  const existing = await dbGet(
    `SELECT id, token FROM documentos WHERE evento_id = ? AND tipo = ?`,
    [eventoId || null, tipo]
  );

  const createdAt = new Date().toISOString();

  // Monta nome & salva PDF
  const fileName = nomeArquivo(evRow, existing?.id || 'novo');
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Falha ao gravar PDF em ${filePath}`);
  }

  // Gera (ou reaproveita) token somente após garantir o arquivo
  const token = existing?.token || (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));

  const publicUrl = `/documentos/${fileName}`;

  if (existing) {
    await dbRun(
      `UPDATE documentos
          SET token = ?,
              pdf_url = ?,
              pdf_public_url = ?,
              status = 'gerado'
        WHERE id = ?`,
      [token, filePath, publicUrl, existing.id]
    );
    return { documentoId: existing.id, token, filePath, fileName, publicUrl };
  } else {
    const ins = await dbRun(
      `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'gerado', ?)`,
      [tipo, token, permissionarioId || null, eventoId || null, filePath, publicUrl, createdAt]
    );
    const documentoId = ins.lastID;
    return { documentoId, token, filePath, fileName, publicUrl };
  }
}

/**
 * Gera o PDF do termo (HTML → PDF) e upserta em `documentos`.
 * Retorna { documentoId, token, filePath, fileName, pdf_public_url, urlTermoPublic }.
 */
async function gerarTermoEventoEIndexar(eventoId) {
  // Usa dados brutos do evento para compor o nome do arquivo
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`, [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  const payload = await buildPayloadFromEvento(eventoId);
  const html = compileHtmlTemplate(payload);
  const pdfBuf = await htmlToPdfBuffer(html);

  const doc = await salvarDocumentoRegistro(
    pdfBuf,
    'termo_evento',
    null,           // permissionario_id (não se aplica aqui)
    eventoId,
    ev
  );

  const urlTermoPublic = `/eventos/termo.html?id=${doc.documentoId}`;
  return { ...doc, pdf_public_url: doc.publicUrl, urlTermoPublic };
}

module.exports = { gerarTermoEventoEIndexar, buildPayloadFromEvento };
