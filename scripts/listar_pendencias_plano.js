const fs=require('fs');
const {parse}=require('csv-parse/sync');
const {stringify}=require('csv-stringify/sync');
const IN=process.argv[2]||'./plano_final_preenchido.csv'; 
const OUT=process.argv[3]||'./plano_pendencias_para_preencher.csv';

function iso(s){ if(!s)return'';const t=String(s).trim(); if(/^\d{4}-\d{2}-\d{2}$/.test(t))return t; const m=t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m){const[_,d,mo,y]=m;return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;} return ''; }

function toNum(x){ if(x==null||x==='')return NaN; const f=parseFloat(String(x).replace(',','.')); return Number.isFinite(f)?f:NaN; }

const rows=parse(fs.readFileSync(IN,'utf8'),{columns:true,skip_empty_lines:true});

const pend=rows.filter(r=>String(r.acao||'').toUpperCase().startsWith('CRIAR') && (!Number.isFinite(toNum(r.valor)) || !iso(r.data_vencimento)));
if(!pend.length){ console.log('Sem pendências'); process.exit(0); }
fs.writeFileSync(OUT, stringify(pend,{header:true}), 'utf8'); console.log(`Gerado ${OUT} com ${pend.length} linhas`);
