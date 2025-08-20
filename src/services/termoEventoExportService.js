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

// ---------- utils ----------
const onlyDigits = (v='') => String(v).replace(/\D/g,'');
const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n||0));
const fmtArea = (n) => {
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

// carrega HTML do template público
function compileHtmlTemplate(payload) {
  const templatePath = path.resolve(process.cwd(), 'public', 'termo-permisao.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template não encontrado: ${templatePath}`);
  }
  const html = fs.readFileSync(templatePath, 'utf8');
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

// monta o payload completo para o template
async function buildPayloadFromEvento(eventoId) {
  // Evento + Cliente
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.email, c.telefone, c.endereco,
            c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`, [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  // Parcelas
  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`, [eventoId]
  );

  // Derivações
  const periodo = mkPeriodo(ev.datas_evento);
  const datasArr = String(ev.datas_evento||'').split(',').map(s=>s.trim()).filter(Boolean);
  const primeiraData = datasArr[0] || null;
  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
  const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;

  const sinal = parcelas[0]?.data_vencimento || null;
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  // Permintente (da .env para não “engessar” no código)
  const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj  = process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30';
  const permitenteEnd   = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf= process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  // Órgão (cabeçalho)
  const orgUF  = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  // Placeholders NOVOS (seu template)
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

    vigencia_fim_datahora: ev.data_vigencia_final ? `${new Date(ev.data_vigencia_final+'T12:00:00').toLocaleDateString('pt-BR')} às 12h` : '',

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

  // (Compat) placeholders antigos usados no seu html minimalista
  const payloadCompat = {
    processo: ev.numero_processo || '',
    evento: ev.nome_evento || '',
    periodo: periodo || fmtDataExtenso(primeiraData)
  };

  // Retorna ambos (o template usará o que existir)
  return { ...payloadTermo, ...payloadCompat };
}

function nomeArquivo(ev, idDoc) {
  const razao = (ev?.nome_razao_social || 'Cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'_');
  const dataPrimeira = (String(ev?.datas_evento||'').split(',')[0]||'').trim();
  return `TermoPermissao_${ev?.numero_termo || 's-n'}_${razao}_Data-${dataPrimeira || 's-d'}_${idDoc}.pdf`;
}

async function salvarDocumentoRegistro(buffer, tipo, permissionarioId, eventoId, evRow) {
  // tabela documentos (com colunas novas)
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE,
    permissionario_id INTEGER,
    evento_id INTEGER,
    pdf_url TEXT,
    pdf_public_url TEXT,
    assinafy_id TEXT,
    status TEXT DEFAULT 'gerado',
    signed_pdf_public_url TEXT,
    signed_at TEXT,
    signer TEXT,
    created_at TEXT
  )`);
  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo
               ON documentos(evento_id, tipo)`);

  // diretório público
  const dir = path.resolve(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(dir, { recursive: true });

  // cria entrada para obter id
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
    null,
    eventoId,
    ev
  );

  // página pública para o cliente ler/assinar
  const urlTermoPublic = `/eventos/termo.html?id=${doc.documentoId}`;

  return { ...doc, pdf_public_url: doc.publicUrl, urlTermoPublic };
}

module.exports = { gerarTermoEventoEIndexar };
