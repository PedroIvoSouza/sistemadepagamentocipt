#!/usr/bin/env node
const fs = require('fs'); const { parse } = require('csv-parse/sync'); const { stringify } = require('csv-stringify/sync');

function normProc(s){ if(!s) return ''; let up=String(s).toUpperCase().trim().replace(/^E:/,'').replace(/\s+/g,''); const m=up.match(/^(\d+)\.(\d+)\/(\d{4})$/); if(!m){ const m2=up.match(/(\d{4})$/); const ano=m2?m2[1]:null; const baseSeq=up.replace(/\/?\d{4}$/,''); let base=null,seq=null; if(baseSeq.includes('.'))[base,seq]=baseSeq.split('.'); if(seq) seq=seq.replace(/^0+/,'')||'0'; return (base&&ano)?`${base}.${seq}/${ano}`:up; } const [,base,seq,ano]=m; const seqn=String(seq).replace(/^0+/,'')||'0'; return `${base}.${seqn}/${ano}`; }
function iso(s){ if(!s) return ''; const t=String(s).trim(); if(/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; const m=t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m){ const [_,d,mo,y]=m; return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;} return ''; }
function addOneMonthSameDay(yyyy_mm_dd){ if(!/^\d{4}-\d{2}-\d{2}$/.test(yyyy_mm_dd)) return ''; const [y,m,d]=yyyy_mm_dd.split('-').map(n=>parseInt(n,10)); const targetMonth=m+1; const ny = y + Math.floor((targetMonth-1)/12); const nm = ((targetMonth-1)%12)+1; const lastDay = new Date(ny, nm, 0).getDate(); const day = Math.min(d, lastDay); return `${ny}-${String(nm).padStart(2,'0')}-${String(day).padStart(2,'0')}`; }
function toNum(x){ if(x==null||x==='') return NaN; const f=parseFloat(String(x).replace(',','.')); return Number.isFinite(f)?f:NaN; }

const IN = './plano_final_para_importar_e_emitir.csv';
const OUT= './plano_final_preenchido.csv';
const rows = parse(fs.readFileSync(IN,'utf8'), { columns:true, skip_empty_lines:true });

// indexar P1 por processo
const p1 = new Map();
for(const r of rows){
  const proc = normProc(r.processo_norm || r.processo_plan || r.processo_sistema || '');
  const parcela = String(r.parcela||'1').trim();
  if(parcela==='1'){
    const v = toNum(r.valor);
    const d = iso(r.data_vencimento);
    if(Number.isFinite(v) && d) p1.set(proc, { valor:v, venc:d });
  }
}

// preencher P2 (apenas quando ACÃO exige criação; para emitir/baixar não arriscamos)
let alteradas = 0;
for(const r of rows){
  const acao = String(r.acao||'').toUpperCase();
  if(!acao.startsWith('CRIAR')) continue;
  const proc = normProc(r.processo_norm || r.processo_plan || r.processo_sistema || '');
  const parcela = String(r.parcela||'1').trim();
  if(parcela!=='2') continue;

  let v = toNum(r.valor);
  let d = iso(r.data_vencimento);
  const ref = p1.get(proc);
  if(ref){
    if(!Number.isFinite(v)) { r.valor = String(ref.valor); alteradas++; }
    if(!d) { r.data_vencimento = addOneMonthSameDay(ref.venc); alteradas++; }
  }
}

fs.writeFileSync(OUT, stringify(rows,{header:true}), 'utf8');
console.log(`Gerado ${OUT} | campos preenchidos: ${alteradas}`);
