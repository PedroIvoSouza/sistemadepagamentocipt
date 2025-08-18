// vincular_gcs_privado.js
// Uso:
//   node vincular_gcs_privado.js --bucket dars_de_agosto --prefix 2025-08 \
//     --permXlsx ./data/permissionarios_atualizada.xlsx
//
// Dep.: npm i sqlite3 pdf-parse xlsx @google-cloud/storage
// Permissões: a VM precisa ler o bucket (Storage Object Viewer).

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const pdfParse = require('pdf-parse');
const xlsx = require('xlsx');
const {Storage} = require('@google-cloud/storage');

const args = (a=>{const o={};for(let i=0;i<a.length;i+=2){const k=a[i]?.replace(/^--/,'');const v=a[i+1];if(k)o[k]=v;}return o;})(process.argv.slice(2));
const BUCKET = args.bucket || 'dars_de_agosto';
const PREFIX = (args.prefix || '2025-08').replace(/^\/+|\/+$/g,'');
const PERM_XLSX = args.permXlsx || './data/permissionarios_atualizada.xlsx';

const db = new sqlite3.Database('./sistemacipt.db');
const storage = new Storage();

const TMP_DIR = path.join(os.tmpdir(), 'dars_gcs_privado');
fs.mkdirSync(TMP_DIR, {recursive: true});

const RE_CNPJ  = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;
const RE_MONEY = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/;
const RE_DATE  = /\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/;
const RE_LINHA = /((?:\d[\s\.]?){47,60})/i;

const onlyDigits = s => (s||'').toString().replace(/\D+/g,'');
const parseMoney = s => { if(!s) return null; const m=s.match(RE_MONEY); if(!m)return null; const f=parseFloat(m[1].replace(/\./g,'').replace(',','.')); return Number.isFinite(f)?f:null; };
const parseDate  = s => { if(!s) return null; const m=s.match(RE_DATE);  if(!m)return null; const [_,dd,mm,yyyy]=m; return `${yyyy}-${mm}-${dd}`; };

function loadCNPJsFromXlsx(file){
  const wb = xlsx.readFile(file);
  const name = wb.SheetNames.find(n=>/permission[aá]rios?/i.test(n)) || wb.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[name], {defval:''});
  if(!rows.length) return new Set();
  const col = Object.keys(rows[0]).find(h=>/cnpj_cpf|cnpj\/cpf|cnpj|documento/i.test(h)) || Object.keys(rows[0])[0];
  const set = new Set();
  for (const r of rows) {
    const d = onlyDigits(r[col]);
    if (d.length === 14) set.add(d);
  }
  return set;
}

function ensureColumns(){
  return new Promise(resolve=>{
    db.all(`PRAGMA table_info(dars)`, (err, rows)=>{
      if (err) return resolve();
      const hasGsUri = rows?.some(r=>r.name==='pdf_gs_uri');
      const stmts = [];
      if (!hasGsUri) stmts.push(`ALTER TABLE dars ADD COLUMN pdf_gs_uri TEXT;`);
      if (!stmts.length) return resolve();
      db.serialize(()=>{ const next=()=>{const s=stmts.shift(); if(!s) return resolve(); db.run(s,[],next);}; next(); });
    });
  });
}

async function downloadTemp(file){
  const dst = path.join(TMP_DIR, path.basename(file.name));
  await file.download({destination: dst});
  return dst;
}

async function parseMeta(localPath){
  try{
    const buf = fs.readFileSync(localPath);
    const parsed = await pdfParse(buf);
    const text = parsed.text || '';

    // CNPJ
    let cnpj = null; const mC = text.match(RE_CNPJ); if (mC) cnpj = onlyDigits(mC[0]);
    if (!cnpj || cnpj.length!==14) {
      const fromName = onlyDigits(path.basename(localPath, '.pdf'));
      if (fromName.length===14) cnpj = fromName;
    }

    const valor = parseMoney(text);
    const venc  = parseDate(text);
    return {cnpj, valor, venc};
  }catch(e){
    return {cnpj:null, valor:null, venc:null};
  }
}

function findDAR(cnpj, venc, valor){
  return new Promise(resolve=>{
    if (!cnpj || !venc || valor==null) return resolve([]);
    const sql = `
      SELECT d.id, d.valor, d.data_vencimento, d.mes_referencia, d.ano_referencia, p.cnpj, p.nome_empresa
      FROM dars d
      JOIN permissionarios p ON p.id = d.id_permissionario
      WHERE p.cnpj = ?
        AND d.mes_referencia = 8 AND d.ano_referencia = 2025
        AND date(d.data_vencimento) = date(?)
        AND ABS(d.valor - ?) < 0.01
      ORDER BY d.id DESC
      LIMIT 5`;
    db.all(sql, [cnpj, venc, valor], (err, rows)=>{
      if (err) return resolve([]);
      resolve(rows||[]);
    });
  });
}

function updateGsUri(darId, gsUri){
  return new Promise(resolve=>{
    db.run(`UPDATE dars SET pdf_gs_uri = ? WHERE id = ?`, [gsUri, darId], function(err){
      if (err) console.error('ERRO update:', err.message);
      resolve(!err);
    });
  });
}

(async function main(){
  try{
    const allowedCNPJs = fs.existsSync(PERM_XLSX) ? loadCNPJsFromXlsx(PERM_XLSX) : new Set();
    await ensureColumns();

    const bucket = storage.bucket(BUCKET);
    const [files] = await bucket.getFiles({ prefix: PREFIX ? `${PREFIX}/` : undefined });
    let ok=0, warn=0, skip=0;

    for (const file of files.filter(f=>/\.pdf$/i.test(f.name))) {
      const base = path.basename(file.name).toLowerCase();
      if (base.includes('mesha') || base.includes('go digital') || base.includes('godigital')) { skip++; continue; }

      const local = await downloadTemp(file);
      const meta = await parseMeta(local);

      if (!meta.cnpj || meta.cnpj.length!==14 || (allowedCNPJs.size && !allowedCNPJs.has(meta.cnpj))) {
        console.warn(`SKIP CNPJ inválido/fora da planilha: ${file.name}`);
        skip++; continue;
      }
      if (!meta.venc || meta.valor==null) {
        console.warn(`WARN sem venc/valor: ${file.name}`);
        warn++; continue;
      }

      const matches = await findDAR(meta.cnpj, meta.venc, meta.valor);
      if (matches.length !== 1) {
        console.warn(`WARN match=${matches.length} para ${file.name} (CNPJ ${meta.cnpj}, Venc ${meta.venc}, Valor ${meta.valor})`);
        warn++; continue;
      }

      const gsUri = `gs://${BUCKET}/${file.name}`;
      const okUpd = await updateGsUri(matches[0].id, gsUri);
      if (okUpd) { console.log(`OK: DAR ${matches[0].id} ← ${gsUri}`); ok++; } else { warn++; }
    }

    console.log(`\nResumo: OK=${ok} WARN=${warn} SKIP=${skip} TOTAL_PDFS=${files.length}`);
    db.close();
  }catch(e){
    console.error('Falha:', e);
    db.close();
    process.exit(1);
  }
})();
