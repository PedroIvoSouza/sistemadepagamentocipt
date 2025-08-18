// vincular_gcs_privado_v2.js
// Uso sugerido (bucket privado, PDFs na raiz do bucket):
//   node vincular_gcs_privado_v2.js \
//     --bucket dars_de_agosto \
//     --prefix "/" \
//     --permXlsx ./permissionarios_atualizada.xlsx \
//     --ignorePermSheet true \
//     --updateDbFromPdf true
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
const IGNORE_PERM_SHEET = String(args.ignorePermSheet||'false').toLowerCase() === 'true';
const UPDATE_DB_FROM_PDF = String(args.updateDbFromPdf||'false').toLowerCase() === 'true';
const MONTH = parseInt(args.month || '8', 10);
const YEAR  = parseInt(args.year  || '2025', 10);

// -------------- Setup ---------------
const db = new sqlite3.Database('./sistemacipt.db');
const storage = new Storage();
const TMP_DIR = path.join(os.tmpdir(), 'dars_gcs_priv_v2');
fs.mkdirSync(TMP_DIR, { recursive: true });

// -------------- Helpers -------------
const RE_CNPJ  = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;
const RE_MONEY = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/;
const RE_DATE  = /\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/;
const RE_LINHA = /((?:\d[\s\.]?){47,60})/i;

const onlyDigits = s => (s||'').toString().replace(/\D+/g,'');
const parseMoney = s => { if(!s)return null; const m=s.match(RE_MONEY); if(!m)return null; const f=parseFloat(m[1].replace(/\./g,'').replace(',','.')); return Number.isFinite(f)?f:null; };
const parseDate  = s => { if(!s)return null; const m=s.match(RE_DATE);  if(!m)return null; const [_,dd,mm,yyyy]=m; return `${yyyy}-${mm}-${dd}`; };

const LD_to_barcode = (ld) => {
  const d = onlyDigits(ld||'');
  if (d.length === 47) {
    try { return d.slice(0,4)+d.slice(32,33)+d.slice(33,47)+d.slice(4,9)+d.slice(10,20)+d.slice(21,31); }
    catch { return ''; }
  }
  if (d.length === 48) return d;
  return '';
};

function loadCNPJsFromXlsx(file) {
  if (!fs.existsSync(file)) return new Set();
  const wb = xlsx.readFile(file);
  const name = wb.SheetNames.find(n=>/permission[aá]rios?/i.test(n)) || wb.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[name], { defval:'' });
  if (!rows.length) return new Set();
  const col = Object.keys(rows[0]).find(h=>/cnpj_cpf|cnpj\/cpf|cnpj|documento/i.test(h)) || Object.keys(rows[0])[0];
  const set = new Set();
  for (const r of rows) { const d = onlyDigits(r[col]); if (d.length===14) set.add(d); }
  return set;
}

function ensureColumns(){
  return new Promise(resolve=>{
    db.all(`PRAGMA table_info(dars)`, (err, rows)=>{
      if (err) return resolve();
      const need = [];
      if (!rows?.some(r=>r.name==='pdf_gs_uri')) need.push(`ALTER TABLE dars ADD COLUMN pdf_gs_uri TEXT;`);
      if (!rows?.some(r=>r.name==='linha_digitavel')) need.push(`ALTER TABLE dars ADD COLUMN linha_digitavel TEXT;`);
      if (!rows?.some(r=>r.name==='codigo_barras')) need.push(`ALTER TABLE dars ADD COLUMN codigo_barras TEXT;`);
      if (!need.length) return resolve();
      db.serialize(()=>{ const next=()=>{const s=need.shift(); if(!s) return resolve(); db.run(s,[],next);}; next();});
    });
  });
}

async function downloadTemp(file){
  const dst = path.join(TMP_DIR, path.basename(file.name));
  await file.download({ destination: dst });
  return dst;
}

async function extractMeta(localPath) {
  try {
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
    const codbar = LD_to_barcode(ld);
    return { cnpj, valor, venc, ld, codbar };
  } catch {
    return { cnpj:null, valor:null, venc:null, ld:'', codbar:'' };
  }
}

// --- matching: por CNPJ + MÊS/ANO; valor/venc como ajuda ---
function findCandidatesByMonth(cnpj, month, year) {
  return new Promise(resolve=>{
    const sql = `
      SELECT d.id, d.valor, d.data_vencimento, d.numero_documento, d.linha_digitavel, d.codigo_barras
      FROM dars d
      JOIN permissionarios p ON p.id = d.id_permissionario
      WHERE p.cnpj = ?
        AND d.mes_referencia = ?
        AND d.ano_referencia = ?
      ORDER BY d.id DESC`;
    db.all(sql, [cnpj, month, year], (err, rows)=> resolve(rows||[]));
  });
}

function updateRecord(darId, gsUri, patch){
  return new Promise(resolve=>{
    const sets = ['pdf_gs_uri = ?'];
    const vals = [gsUri];
    if (UPDATE_DB_FROM_PDF) {
      if (patch.venc) { sets.push('data_vencimento = ?'); vals.push(patch.venc); }
      if (patch.valor!=null) { sets.push('valor = ?'); vals.push(patch.valor); }
      if (patch.ld) { sets.push('linha_digitavel = ?'); vals.push(patch.ld); }
      if (patch.codbar) { sets.push('codigo_barras = ?'); vals.push(patch.codbar); }
    }
    vals.push(darId);
    const sql = `UPDATE dars SET ${sets.join(', ')} WHERE id = ?`;
    db.run(sql, vals, function(err){
      if (err) console.error(`ERRO update DAR ${darId}:`, err.message);
      resolve(!err);
    });
  });
}

// ---------------- main ---------------
(async function main(){
  const permSet = IGNORE_PERM_SHEET ? new Set() : loadCNPJsFromXlsx(PERM_XLSX);
  await ensureColumns();

  const bucket = storage.bucket(BUCKET);
  const [files] = await bucket.getFiles({ prefix: PREFIX ? `${PREFIX}/` : undefined });

  let OK=0, WARN=0, SKIP=0, TOTAL=0;

  for (const file of files.filter(f=>/\.pdf$/i.test(f.name))) {
    TOTAL++;
    const base = path.basename(file.name).toLowerCase();
    if (base.includes('mesha') || base.includes('go digital') || base.includes('godigital')) { SKIP++; continue; }

    const local = await downloadTemp(file);
    const meta = await extractMeta(local);

    if (!meta.cnpj || meta.cnpj.length!==14) { console.warn(`SKIP CNPJ inválido: ${file.name}`); SKIP++; continue; }
    if (permSet.size && !permSet.has(meta.cnpj)) { console.warn(`SKIP fora da planilha: ${file.name}`); SKIP++; continue; }

    const candidates = await findCandidatesByMonth(meta.cnpj, MONTH, YEAR);
    if (candidates.length === 0) {
      console.warn(`WARN: sem DAR no banco para CNPJ ${meta.cnpj} em ${MONTH}/${YEAR} → ${file.name}`);
      WARN++; continue;
    }

    let chosen = null;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      // tenta pelo valor (tolerância 0.05); senão, escolhe o mais próximo
      const withTol = candidates.filter(c => Math.abs(c.valor - (meta.valor ?? c.valor)) < 0.05);
      if (withTol.length === 1) chosen = withTol[0];
      else if (withTol.length > 1) {
        chosen = withTol.sort((a,b)=>Math.abs(a.valor-(meta.valor??a.valor)) - Math.abs(b.valor-(meta.valor??b.valor)))[0];
      } else {
        chosen = candidates.sort((a,b)=>Math.abs(a.valor-(meta.valor??a.valor)) - Math.abs(b.valor-(meta.valor??b.valor)))[0];
      }
    }

    const gsUri = `gs://${BUCKET}/${file.name}`;
    const patched = {
      venc: meta.venc || null,
      valor: meta.valor ?? null,
      ld: meta.ld || null,
      codbar: meta.codbar || null
    };
    const ok = await updateRecord(chosen.id, gsUri, patched);
    if (ok) { console.log(`OK: DAR ${chosen.id} ← ${gsUri}`); OK++; } else { WARN++; }
  }

  console.log(`\nResumo: OK=${OK} WARN=${WARN} SKIP=${SKIP} TOTAL_PDFS=${TOTAL}`);
  db.close();
})();
