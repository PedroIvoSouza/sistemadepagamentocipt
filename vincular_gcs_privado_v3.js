// vincular_gcs_privado_v3.js
// Fluxo: ler PDFs privados no GCS → extrair meta → ajustar CNPJ pelo nome/planilha →
//        achar DAR de ago/2025 (CNPJ) → atualizar OU criar (sem reemitir) → gravar gs://
//
// Uso típico:
//   node vincular_gcs_privado_v3.js \
//     --bucket dars_de_agosto \
//     --prefix "/" \
//     --permXlsx ./permissionarios_atualizada.xlsx \
//     --updateDbFromPdf true \
//     --createMissing true
//
// Dep.: npm i sqlite3 pdf-parse xlsx @google-cloud/storage
// A VM precisa de permissão de leitura no bucket (roles/storage.objectViewer)

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

// ---------------- Setup ----------------
const db = new sqlite3.Database('./sistemacipt.db');
const storage = new Storage();
const TMP_DIR = path.join(os.tmpdir(), 'dars_gcs_priv_v3');
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
const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim().toUpperCase();
const includesAll = (hay, tokens) => tokens.every(t => hay.includes(t));

// Overrides por nome (ajuste/expanda se precisar)
const CNPJ_OVERRIDES_BY_NAME = [
  { match: ['CERTAME', 'MARCAS', 'PATENTES'], cnpj: '30441031000220' }, // LTDA (não EIRELI)
  { match: ['ENNI'], cnpj: '46731465000113' },
  { match: ['VTEX'], cnpj: '05314972000174' },
  { match: ['WENI'], cnpj: '05314972000174' },
];

// ---------------- Planilha ----------------
function loadPermMaps(xlsxPath){
  const byCnpj = new Map();
  const byName = new Map(); // nome normalizado -> cnpj

  if (!fs.existsSync(xlsxPath)) return { byCnpj, byName };
  const wb = xlsx.readFile(xlsxPath);
  const sheetName = wb.SheetNames.find(n=>/permission[aá]rios?/i.test(n)) || wb.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval:'' });
  if (!rows.length) return { byCnpj, byName };

  // tenta achar colunas prováveis
  const headers = Object.keys(rows[0]);
  const colDoc = headers.find(h=>/cnpj_cpf|cnpj\/cpf|cnpj|documento/i.test(h)) || headers[0];
  const colNome = headers.find(h=>/nome|razao|empresa|razao_social|fantasia/i.test(h)) || headers[1] || colDoc;

  for (const r of rows) {
    const cnpj = onlyDigits(r[colDoc]);
    if (cnpj.length !== 14) continue;
    const nome = norm(r[colNome] || '');
    if (nome) byName.set(nome, cnpj);
    byCnpj.set(cnpj, nome);
  }
  return { byCnpj, byName };
}

// ---------------- DB helpers ----------------
function ensureColumns(){
  return new Promise(resolve=>{
    db.all(`PRAGMA table_info(dars)`, (err, rows)=>{
      if (err) return resolve();
      const need = [];
      const has = name => rows?.some(r=>r.name===name);
      if (!has('pdf_gs_uri'))    need.push(`ALTER TABLE dars ADD COLUMN pdf_gs_uri TEXT;`);
      if (!has('linha_digitavel')) need.push(`ALTER TABLE dars ADD COLUMN linha_digitavel TEXT;`);
      if (!has('codigo_barras'))   need.push(`ALTER TABLE dars ADD COLUMN codigo_barras TEXT;`);
      if (!need.length) return resolve();
      db.serialize(()=>{ const next=()=>{const s=need.shift(); if(!s) return resolve(); db.run(s,[],next);}; next();});
    });
  });
}
function getPermissionarioByCNPJ(cnpj){
  return new Promise(resolve=>{
    db.get(`SELECT id, nome_empresa FROM permissionarios WHERE cnpj = ?`, [cnpj], (e,row)=> resolve(row||null));
  });
}
function findDARsByMonth(cnpj, m, y){
  return new Promise(resolve=>{
    const sql = `
      SELECT d.id, d.valor, d.data_vencimento, d.numero_documento, d.linha_digitavel, d.codigo_barras
      FROM dars d
      JOIN permissionarios p ON p.id = d.id_permissionario
      WHERE p.cnpj = ? AND d.mes_referencia = ? AND d.ano_referencia = ?
      ORDER BY d.id DESC`;
    db.all(sql, [cnpj, m, y], (e, rows)=> resolve(rows||[]));
  });
}
function updateDAR(darId, patch){
  return new Promise(resolve=>{
    const sets = [];
    const vals = [];
    if (patch.pdf_gs_uri !== undefined) { sets.push('pdf_gs_uri = ?'); vals.push(patch.pdf_gs_uri); }
    if (UPDATE_DB_FROM_PDF) {
      if (patch.data_vencimento) { sets.push('data_vencimento = ?'); vals.push(patch.data_vencimento); }
      if (patch.valor != null)   { sets.push('valor = ?');           vals.push(patch.valor); }
      if (patch.linha_digitavel) { sets.push('linha_digitavel = ?'); vals.push(patch.linha_digitavel); }
      if (patch.codigo_barras)   { sets.push('codigo_barras = ?');   vals.push(patch.codigo_barras); }
    }
    if (!sets.length) return resolve(true);
    vals.push(darId);
    const sql = `UPDATE dars SET ${sets.join(', ')} WHERE id = ?`;
    db.run(sql, vals, function(err){ if (err) console.error('ERRO update:', err.message); resolve(!err); });
  });
}
function insertDAR(id_permissionario, meta){
  return new Promise(resolve=>{
    const sql = `INSERT INTO dars (
      id_permissionario, tipo_permissionario, valor, mes_referencia, ano_referencia,
      data_vencimento, status, numero_documento, linha_digitavel, codigo_barras, pdf_gs_uri
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
      id_permissionario, 'Permissionario',
      meta.valor ?? null, MONTH, YEAR,
      meta.venc || null, 'Pendente',
      meta.numero_documento || meta.arquivo || null,
      meta.ld || null, meta.codbar || null,
      meta.gsUri || null
    ];
    db.run(sql, params, function(err){
      if (err) { console.error('ERRO insert DAR:', err.message); return resolve(null); }
      resolve(this.lastID);
    });
  });
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
  const { byCnpj, byName } = loadPermMaps(PERM_XLSX);
  await ensureColumns();

  const bucket = storage.bucket(BUCKET);
  const [files] = await bucket.getFiles({ prefix: PREFIX ? `${PREFIX}/` : undefined });

  let OK=0, CREATED=0, WARN=0, SKIP=0, TOTAL=0;

  for (const file of files.filter(f=>/\.pdf$/i.test(f.name))) {
    TOTAL++;
    const base = path.basename(file.name);
    const baseNorm = norm(base);
    const skipByName = baseNorm.includes('MESHA') || baseNorm.includes('GO DIGITAL') || baseNorm.includes('GODIGITAL');
    if (skipByName) { SKIP++; continue; }

    const local = await downloadTemp(file);
    const meta = await extractMeta(local);
    meta.arquivo = base;
    meta.gsUri = `gs://${BUCKET}/${file.name}`;

    // 1) Override por nome (CERTAME/ENNI/VTEX/WENI etc.)
    for (const o of CNPJ_OVERRIDES_BY_NAME) {
      if (includesAll(baseNorm, o.match)) meta.cnpj = o.cnpj;
    }

    // 2) Se ainda assim CNPJ não bate com sistema, tente pelo nome da planilha (fuzzy simples)
    if ((!meta.cnpj || !byCnpj.has(meta.cnpj)) && byName.size) {
      // acha 1 único candidato cujo nome contenha todos os tokens do arquivo
      const tokens = baseNorm.replace(/\b(DAR|AGOSTO|PDF)\b/g,'').trim().split(/\s+/).filter(t=>t.length>2);
      const candidates = [];
      for (const [nomeNorm, cnpj] of byName.entries()) {
        const hit = tokens.filter(t => nomeNorm.includes(t)).length;
        if (hit >= 2) candidates.push({ cnpj, hit, nomeNorm });
      }
      if (candidates.length) {
        candidates.sort((a,b)=>b.hit - a.hit);
        const chosen = candidates[0];
        meta.cnpj = chosen.cnpj;
      }
    }

    if (!meta.cnpj || meta.cnpj.length!==14) {
      console.warn(`SKIP CNPJ inválido/indisponível → ${base}`);
      SKIP++; continue;
    }

    // 3) Encontrar/Inserir DAR (CNPJ + MÊS/ANO)
    const perm = await getPermissionarioByCNPJ(meta.cnpj);
    if (!perm) {
      console.warn(`WARN: permissionário não encontrado para CNPJ ${meta.cnpj} → ${base}`);
      WARN++; continue;
    }

    const candidates = await findDARsByMonth(meta.cnpj, MONTH, YEAR);
    if (candidates.length === 0) {
      if (!CREATE_MISSING) {
        console.warn(`WARN: sem DAR ${MONTH}/${YEAR} no banco para ${meta.cnpj} (${perm.nome_empresa}) → ${base}`);
        WARN++; continue;
      }
      // criar a DAR a partir do PDF
      const newId = await insertDAR(perm.id, {
        valor: meta.valor,
        venc: meta.venc,
        numero_documento: meta.numero_documento,
        ld: meta.ld,
        codbar: meta.codbar,
        gsUri: meta.gsUri
      });
      if (newId) { console.log(`CREATED: DAR ${newId} (${perm.nome_empresa}) ← ${meta.gsUri}`); CREATED++; }
      else { WARN++; }
      continue;
    }

    // Se houver mais de uma no mês, escolher por valor mais próximo
    let chosen = candidates[0];
    if (candidates.length > 1 && meta.valor != null) {
      chosen = candidates.slice().sort((a,b)=>Math.abs(a.valor - meta.valor) - Math.abs(b.valor - meta.valor))[0];
    }

    const ok = await updateDAR(chosen.id, {
      pdf_gs_uri: meta.gsUri,
      data_vencimento: meta.venc,
      valor: meta.valor,
      linha_digitavel: meta.ld,
      codigo_barras: meta.codbar
    });
    if (ok) { console.log(`OK: DAR ${chosen.id} (${perm.nome_empresa}) ← ${meta.gsUri}`); OK++; } else { WARN++; }
  }

  console.log(`\nResumo: OK=${OK} CREATED=${CREATED} WARN=${WARN} SKIP=${SKIP} TOTAL_PDFS=${TOTAL}`);
  db.close();
})();
