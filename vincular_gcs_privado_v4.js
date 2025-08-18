// vincular_gcs_privado_v4.js
// Lê PDFs privados do GCS, extrai metadados e vincula às DARs de AGO/2025.
// Ajustes principais deste v4:
//  - NÃO faz fuzzy por nome (evita trocar CNPJ incorretamente).
//  - Só aplica overrides explícitos (CERTAME/ENNI/VTEX-WENI).
//  - Descobre o schema da tabela 'dars' via PRAGMA e monta INSERT/UPDATE dinâmicos
//    usando a FK real (permissionario_id, id_permissionario, etc) ou CNPJ direto.
// Uso:
// node vincular_gcs_privado_v4.js \
//   --bucket dars_de_agosto \
//   --prefix "/" \
//   --permXlsx ./permissionarios_atualizada.xlsx \
//   --updateDbFromPdf true \
//   --createMissing true
//
// Dep.: npm i sqlite3 pdf-parse xlsx @google-cloud/storage

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const pdfParse = require('pdf-parse');
const xlsx = require('xlsx');
const { Storage } = require('@google-cloud/storage');

// ---------------- CLI ----------------
const args = (a=>{const o={};for(let i=0;i<a.length;i+=2){const k=a[i]?.replace(/^--/,'');const v=a[i+1];if(k)o[k]=v;}return o;})(process.argv.slice(2));
const BUCKET = args.bucket || 'dars_de_agosto';
let PREFIX   = (args.prefix || '/').trim();
if (PREFIX === '/' || PREFIX === '') PREFIX = ''; else PREFIX = PREFIX.replace(/^\/+|\/+$/g,'');
const PERM_XLSX = args.permXlsx || './permissionarios_atualizada.xlsx';
const UPDATE_DB_FROM_PDF = String(args.updateDbFromPdf||'false').toLowerCase() === 'true';
const CREATE_MISSING     = String(args.createMissing||'false').toLowerCase() === 'true';
const MONTH = parseInt(args.month || '8', 10);
const YEAR  = parseInt(args.year  || '2025', 10);

const db = new sqlite3.Database('./sistemacipt.db');
const storage = new Storage();
const TMP_DIR = path.join(os.tmpdir(), 'dars_gcs_priv_v4');
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------- Helpers ----------------
const RE_CNPJ  = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;
const RE_MONEY = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/;
const RE_DATE  = /\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/;
const RE_LINHA = /((?:\d[\s\.]?){47,60})/i;

const onlyDigits = s => (s||'').toString().replace(/\D+/g,'');
const parseMoney = s => { if(!s)return null; const m=s.match(RE_MONEY); if(!m)return null; const f=parseFloat(m[1].replace(/\./g,'').replace(',','.')); return Number.isFinite(f)?f:null; };
const parseDate  = s => { if(!s)return null; const m=s.match(RE_DATE);  if(!m)return null; const [_,dd,mm,yyyy]=m; return `${yyyy}-${mm}-${dd}`; };
const ldToBarcode = (ld) => {
  const d = onlyDigits(ld||'');
  if (d.length === 47) {
    try { return d.slice(0,4)+d.slice(32,33)+d.slice(33,47)+d.slice(4,9)+d.slice(10,20)+d.slice(21,31); }
    catch { return ''; }
  }
  if (d.length === 48) return d;
  return '';
};
const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();

// Overrides EXPLÍCITOS por nome do arquivo (apenas quando realmente contém a palavra-chave):
function maybeOverrideCNPJByFilename(cnpj, filenameUpper) {
  // CERTAME (LTDA, filial 0002-20)
  if (filenameUpper.includes('CERTAME') && filenameUpper.includes('MARCAS') && filenameUpper.includes('PATENTE')) {
    return '30441031000220';
  }
  // ENNI
  if (filenameUpper.includes('ENNI')) {
    return '46731465000113';
  }
  // VTEX / WENI
  if (filenameUpper.includes('VTEX') || filenameUpper.includes('WENI')) {
    return '05314972000174';
  }
  return cnpj; // não mexe nos demais
}

// ---------------- Planilha (opcional, só para validação/diagnóstico) ----------------
function loadPermCNPJs(xlsxPath){
  try{
    if (!fs.existsSync(xlsxPath)) return new Set();
    const wb = xlsx.readFile(xlsxPath);
    const sheetName = wb.SheetNames.find(n=>/permission[aá]rios?/i.test(n)) || wb.SheetNames[0];
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval:'' });
    const headers = Object.keys(rows[0]||{});
    const colDoc = headers.find(h=>/cnpj_cpf|cnpj\/cpf|cnpj|documento/i.test(h)) || headers[0];
    const set = new Set();
    for (const r of rows) {
      const d = onlyDigits(r[colDoc]);
      if (d.length===14) set.add(d);
    }
    return set;
  }catch{ return new Set(); }
}

// ---------------- Schema discovery ----------------
async function getDarsSchema() {
  const cols = await new Promise(resolve => {
    db.all(`PRAGMA table_info(dars)`, (err, rows)=> resolve(rows || []));
  });
  const colNames = new Set(cols.map(c => c.name));

  // tenta achar FK por PRAGMA foreign_key_list
  let fkCol = null;
  const fks = await new Promise(resolve => {
    db.all(`PRAGMA foreign_key_list(dars)`, (err, rows)=> resolve(rows||[]));
  });
  for (const fk of fks) {
    if (/permissionarios?/i.test(fk.table) && colNames.has(fk.from)) {
      fkCol = fk.from; break;
    }
  }
  // se não achou, tenta candidatos comuns
  const candidates = ['permissionario_id','id_permissionario','permissionarioId','idPermissionario','id_perm','id_permissionarios'];
  if (!fkCol) fkCol = candidates.find(c => colNames.has(c)) || null;

  // colunas alternativas que podemos atualizar/inserir
  const avail = {
    fkCol,
    has: (name) => colNames.has(name),
    chooseFirst: (...opts) => opts.find(n => colNames.has(n)) || null
  };
  // coluna de CNPJ direta em dars (se existir)
  const cnpjInDarsCol = ['cnpj','cnpj_permissionario','cnpj_cpf','documento'].find(n => colNames.has(n)) || null;

  return { colNames, fkCol, cnpjInDarsCol };
}

// ---------------- DB helpers ----------------
function getPermissionarioByCNPJ(cnpj){
  return new Promise(res=>{
    db.get(`SELECT id, nome_empresa FROM permissionarios WHERE cnpj = ?`, [cnpj], (e,row)=> res(row||null));
  });
}

function findDARsByMonthWithJoin(cnpj, m, y, fkCol){
  return new Promise(res=>{
    const sql = `
      SELECT d.id, d.valor, d.data_vencimento, d.numero_documento, d.linha_digitavel, d.codigo_barras
      FROM dars d
      JOIN permissionarios p ON p.id = d.${fkCol}
      WHERE p.cnpj = ? AND d.mes_referencia = ? AND d.ano_referencia = ?
      ORDER BY d.id DESC`;
    db.all(sql, [cnpj, m, y], (e,rows)=> res(rows||[]));
  });
}

function findDARsByMonthByCNPJColumn(cnpj, m, y, cnpjCol){
  return new Promise(res=>{
    const sql = `
      SELECT d.id, d.valor, d.data_vencimento, d.numero_documento, d.linha_digitavel, d.codigo_barras
      FROM dars d
      WHERE d.${cnpjCol} = ?
        AND d.mes_referencia = ?
        AND d.ano_referencia = ?
      ORDER BY d.id DESC`;
    db.all(sql, [cnpj, m, y], (e,rows)=> res(rows||[]));
  });
}

function run(sql, params){ return new Promise(resolve => db.run(sql, params, function(err){ resolve({err, lastID:this?.lastID}); })); }
function all(sql, params){ return new Promise(resolve => db.all(sql, params, (err, rows)=> resolve({err, rows:rows||[]}))); }

async function dynamicUpdateDAR(darId, patch, darsSchema){
  const sets = [];
  const vals = [];
  if (darsSchema.colNames.has('pdf_gs_uri') && patch.pdf_gs_uri !== undefined) { sets.push('pdf_gs_uri = ?'); vals.push(patch.pdf_gs_uri); }
  if (UPDATE_DB_FROM_PDF) {
    if (patch.data_vencimento && darsSchema.colNames.has('data_vencimento')) { sets.push('data_vencimento = ?'); vals.push(patch.data_vencimento); }
    if (patch.valor != null     && darsSchema.colNames.has('valor'))           { sets.push('valor = ?');           vals.push(patch.valor); }
    if (patch.linha_digitavel   && darsSchema.colNames.has('linha_digitavel')) { sets.push('linha_digitavel = ?'); vals.push(patch.linha_digitavel); }
    if (patch.codigo_barras     && darsSchema.colNames.has('codigo_barras'))   { sets.push('codigo_barras = ?');   vals.push(patch.codigo_barras); }
    if (patch.numero_documento  && darsSchema.colNames.has('numero_documento')){ sets.push('numero_documento = ?');vals.push(patch.numero_documento); }
  }
  if (!sets.length) return true;
  vals.push(darId);
  const sql = `UPDATE dars SET ${sets.join(', ')} WHERE id = ?`;
  const {err} = await run(sql, vals);
  if (err) console.error('ERRO update DAR:', err.message);
  return !err;
}

async function dynamicInsertDAR(permRow, meta, darsSchema){
  // monta INSERT só com colunas existentes
  const cols = [];
  const vals = [];
  const qs   = [];

  // FK (se existir) OU CNPJ direto em dars (se existir)
  if (darsSchema.fkCol) {
    cols.push(darsSchema.fkCol); vals.push(permRow.id); qs.push('?');
  } else if (darsSchema.cnpjInDarsCol) {
    cols.push(darsSchema.cnpjInDarsCol); vals.push(meta.cnpj); qs.push('?');
  } else {
    console.error("ERRO: tabela dars não tem FK para permissionarios nem coluna de CNPJ; não dá pra criar o vínculo.");
    return null;
  }

  const add = (col, value) => { if (darsSchema.colNames.has(col)) { cols.push(col); vals.push(value); qs.push('?'); } };

  add('tipo_permissionario', 'Permissionario');
  add('valor', meta.valor ?? null);
  add('mes_referencia', MONTH);
  add('ano_referencia', YEAR);
  add('data_vencimento', meta.venc || null);
  add('status', 'Pendente');
  add('numero_documento', meta.numero_documento || meta.arquivo || null);
  add('linha_digitavel', meta.ld || null);
  add('codigo_barras', meta.codbar || null);
  add('pdf_gs_uri', meta.gsUri || null);

  const sql = `INSERT INTO dars (${cols.join(', ')}) VALUES (${qs.join(', ')})`;
  const {err, lastID} = await run(sql, vals);
  if (err) { console.error('ERRO insert DAR:', err.message); return null; }
  return lastID || null;
}

// ---------------- GCS + PDF ----------------
async function downloadTemp(file){
  const dst = path.join(TMP_DIR, path.basename(file.name));
  await file.download({ destination: dst });
  return dst;
}
async function extractMeta(localPath){
  try{
    const buf = fs.readFileSync(localPath);
    const parsed = await pdfParse(buf);
    const text = parsed.text || '';
    let cnpj = null; const mC = text.match(RE_CNPJ); if (mC) cnpj = onlyDigits(mC[0]);
    if (!cnpj || cnpj.length!==14) {
      const fromName = onlyDigits(path.basename(localPath, '.pdf'));
      if (fromName.length===14) cnpj = fromName;
    }
    const valor = parseMoney(text);
    const venc  = parseDate(text);
    let ld = ''; const mL = text.match(RE_LINHA); if (mL) { const cand = onlyDigits(mL[1]); if (cand.length>=47 && cand.length<=60) ld = cand; }
    const codbar = ldToBarcode(ld);
    return { cnpj, valor, venc, ld, codbar, numero_documento: path.basename(localPath, '.pdf') };
  }catch(e){
    return { cnpj:null, valor:null, venc:null, ld:'', codbar:'', numero_documento: path.basename(localPath, '.pdf') };
  }
}

// ---------------- Main ----------------
(async function main(){
  try{
    const permCNPJs = loadPermCNPJs(PERM_XLSX);
    const darsSchema = await getDarsSchema();

    const bucket = storage.bucket(BUCKET);
    const [files] = await bucket.getFiles({ prefix: PREFIX ? `${PREFIX}/` : undefined });

    let OK=0, CREATED=0, WARN=0, SKIP=0, TOTAL=0;

    for (const file of files.filter(f=>/\.pdf$/i.test(f.name))) {
      TOTAL++;
      const base = path.basename(file.name);
      const baseUpper = norm(base);
      if (baseUpper.includes('MESHA') || baseUpper.includes('GO DIGITAL') || baseUpper.includes('GODIGITAL')) { SKIP++; continue; }

      const local = await downloadTemp(file);
      const meta  = await extractMeta(local);
      meta.arquivo = base;
      meta.gsUri   = `gs://${BUCKET}/${file.name}`;

      // overrides explícitos (não mexe nos demais)
      meta.cnpj = maybeOverrideCNPJByFilename(meta.cnpj, baseUpper);

      if (!meta.cnpj || meta.cnpj.length!==14) { console.warn(`SKIP CNPJ inválido: ${base}`); SKIP++; continue; }
      // (opcional) aviso se CNPJ não consta na planilha — mas não bloqueia
      if (permCNPJs.size && !permCNPJs.has(meta.cnpj)) {
        console.warn(`INFO: CNPJ ${meta.cnpj} não consta na planilha (seguindo assim mesmo): ${base}`);
      }

      // localizar permissionário por CNPJ (sempre com dígitos)
      const perm = await getPermissionarioByCNPJ(meta.cnpj);
      if (!perm) {
        console.warn(`WARN: permissionário não encontrado para CNPJ ${meta.cnpj} → ${base}`);
        // sem permissionário fica impossível vincular por FK; se sua 'dars' aceita CNPJ direto, o INSERT dinâmico usará essa coluna.
        // Mesmo assim, tentaremos criar/atualizar usando dynamicInsertDAR (ele decide).
      }

      // buscar DAR existente do mês/ano
      let candidates = [];
      if (darsSchema.fkCol) {
        candidates = await findDARsByMonthWithJoin(meta.cnpj, MONTH, YEAR, darsSchema.fkCol);
      } else if (darsSchema.cnpjInDarsCol) {
        candidates = await findDARsByMonthByCNPJColumn(meta.cnpj, MONTH, YEAR, darsSchema.cnpjInDarsCol);
      }

      if (candidates.length === 0) {
        if (!CREATE_MISSING) {
          console.warn(`WARN: sem DAR ${MONTH}/${YEAR} no banco para ${meta.cnpj} → ${base}`);
          WARN++; continue;
        }
        // criar nova DAR
        const newId = await dynamicInsertDAR(perm || { id: null }, {
          cnpj: meta.cnpj,
          valor: meta.valor,
          venc: meta.venc,
          numero_documento: meta.numero_documento,
          ld: meta.ld,
          codbar: meta.codbar,
          gsUri: meta.gsUri
        }, darsSchema);

        if (newId) { console.log(`CREATED: DAR ${newId} (${perm?.nome_empresa || meta.cnpj}) ← ${meta.gsUri}`); CREATED++; }
        else { WARN++; }
        continue;
      }

      // mais de uma DAR no mês: escolhe por valor mais próximo (se tivermos)
      let chosen = candidates[0];
      if (candidates.length > 1 && meta.valor != null) {
        chosen = candidates.slice().sort((a,b)=>Math.abs(a.valor - meta.valor) - Math.abs(b.valor - meta.valor))[0];
      }

      const ok = await dynamicUpdateDAR(chosen.id, {
        pdf_gs_uri: meta.gsUri,
        data_vencimento: meta.venc,
        valor: meta.valor,
        linha_digitavel: meta.ld,
        codigo_barras: meta.codbar,
        numero_documento: meta.numero_documento
      }, darsSchema);

      if (ok) { console.log(`OK: DAR ${chosen.id} (${perm?.nome_empresa || meta.cnpj}) ← ${meta.gsUri}`); OK++; } else { WARN++; }
    }

    console.log(`\nResumo: OK=${OK} CREATED=${CREATED} WARN=${WARN} SKIP=${SKIP} TOTAL_PDFS=${TOTAL}`);
    db.close();
  }catch(e){
    console.error('Falha:', e);
    db.close();
    process.exit(1);
  }
})();
