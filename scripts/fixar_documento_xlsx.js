// Preenche a coluna "documento" no XLSX do plano usando um mapa vindo do DB.
// Uso:
//  node scripts/fixar_documento_xlsx.js \
//    --in scripts/plano_final_para_importar_e_emitir.xlsx \
//    --map /tmp/map_clientes.csv \
//    --out scripts/plano_final_com_documento.xlsx

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

const args = minimist(process.argv.slice(2), {
  string: ['in','map','out'],
});
if (!args.in || !args.map || !args.out) {
  console.error('Uso: --in <xlsx> --map <csv> --out <xlsx>');
  process.exit(1);
}

function normalizeHeader(h){
  return String(h||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^\w]+/g,'_')
    .replace(/^_+|_+$/g,'');
}
function normProc(s){
  if(!s) return '';
  let up = String(s).toUpperCase().trim().replace(/^E:/,'').replace(/\s+/g,'');
  const m = up.match(/^(\d+)\.(\d+)\/(\d{4})$/);
  if (!m){
    const ano = (up.match(/(\d{4})$/)||[])[1];
    const baseSeq = up.replace(/\/?\d{4}$/,'');
    if(!ano || !baseSeq.includes('.')) return up;
    let [base, seq] = baseSeq.split('.');
    seq = String(seq||'').replace(/^0+/,'') || '0';
    return `${base}.${seq}/${ano}`;
  }
  const [,base,seq,ano] = m;
  const seqn = String(seq).replace(/^0+/,'') || '0';
  return `${base}.${seqn}/${ano}`;
}
function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }

const mapCSV = fs.readFileSync(args.map, 'utf8');
const mapRows = parse(mapCSV, { columns:true, skip_empty_lines:true });
const byProc = new Map();
const byNome = new Map();
for(const r of mapRows){
  const proc = normProc(r.processo_norm||r.processo||r.numero_processo||'');
  const cli  = (r.cliente||r.nome_razao_social||'').toUpperCase().trim();
  const doc  = (r.documento||'').trim();
  if (proc && doc) byProc.set(proc, doc);
  if (cli  && doc) byNome.set(cli,  doc);
}

const wb = XLSX.readFile(args.in);
const shName = wb.SheetNames[0];
const sh = wb.Sheets[shName];
const rows = XLSX.utils.sheet_to_json(sh, { defval:'', raw:false });

let filled = 0, missing = 0;
const outRows = rows.map((row) => {
  // normaliza cabeçalhos → objeto "norm"
  const norm = {};
  for(const [k,v] of Object.entries(row)) norm[normalizeHeader(k)] = v;

  // detecta possíveis campos de processo e nome
  const processo = norm.processo_norm || norm.processo || norm.numero_processo || norm.processo_plan || norm.processo_sistema || '';
  const empresa  = (norm.empresa_plan || norm.cliente || norm.cliente_nome || norm.nome_razao_social || '').toUpperCase().trim();

  let documento = norm.documento || norm.documento_cliente || norm.cnpj || norm.cpf_cnpj || '';
  if (!documento){
    const p = normProc(processo);
    if (p && byProc.has(p)) documento = byProc.get(p);
    else if (empresa && byNome.has(empresa)) documento = byNome.get(empresa);
  }

  if (documento){
    norm.documento = documento;
    if (!row.documento) filled++;
  } else {
    missing++;
  }

  // volta pro formato original preservando as colunas existentes e adicionando "documento" no fim se não existir
  const out = { ...row };
  if (!('documento' in out)) out.documento = norm.documento || '';
  else out.documento = norm.documento || out.documento || '';
  return out;
});

console.log(`Preenchidos agora (documento): ${filled}`);
console.log(`Ainda sem documento: ${missing}`);

const outSh = XLSX.utils.json_to_sheet(outRows, { skipHeader:false });
const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, outSh, shName);
XLSX.writeFile(outWb, args.out);
console.log(`Arquivo gerado: ${args.out}`);
