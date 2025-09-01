#!/usr/bin/env node
/**
 * Saneia e completa o plano:
 * - Agrupa por processo_norm
 * - Usa valor/vencimento âncora do grupo (P1 ou a primeira linha válida)
 * - Preenche valores faltantes com o valor âncora (ou regra específica)
 * - Preenche vencimento faltante: base + (parcela-1) * 1 mês
 *
 * Uso:
 *   node scripts/sanar_plano.js \
 *     --in  scripts/plano_final_preenchido.csv \
 *     --out scripts/plano_final_preenchido_fix.csv
 *
 * Flags opcionais:
 *   --med-valor 15530.89
 *   --med-inicio 2025-09-10
 */

const fs = require('fs');
const minimist = require('minimist');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const args = minimist(process.argv.slice(2), {
  string: ['in','out','med-valor','med-inicio'],
  default: {
    in: 'plano_final_preenchido.csv',
    out: 'plano_final_preenchido_fix.csv',
    'med-valor': '15530.89',
    'med-inicio': '2025-09-10'
  }
});

function detectDelimiter(sample) {
  const first = (sample.split(/\r?\n/)[0] || '').replace(/\r/g,'');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of Object.keys(counts)) counts[ch] = (first.match(new RegExp('\\' + ch, 'g')) || []).length;
  let best = ',', max = -1;
  for (const [ch, c] of Object.entries(counts)) { if (c > max) { max = c; best = ch; } }
  return best;
}

function normProc(s) {
  if (!s) return '';
  let up = String(s).toUpperCase().trim();
  up = up.replace(/^E:/,'').replace(/\s+/g,'');
  const m = up.match(/^(\d+)\.(\d+)\/(\d{4})$/);
  if (!m) {
    const m2 = up.match(/(\d{4})$/);
    const ano = m2 ? m2[1] : null;
    let base = null, seq = null;
    const baseSeq = up.replace(/\/?\d{4}$/,'');
    if (baseSeq.includes('.')) [base, seq] = baseSeq.split('.');
    if (seq) seq = seq.replace(/^0+/,'') || '0';
    return (base && ano) ? `${base}.${seq}/${ano}` : up;
  }
  const [, base, seq, ano] = m;
  const seqn = String(seq).replace(/^0+/,'') || '0';
  return `${base}.${seqn}/${ano}`;
}

function toNum(x) {
  if (x === null || x === undefined) return NaN;
  let s = String(x).trim();
  if (!s) return NaN;
  s = s.replace(/[R$\s\u00A0]/gi, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function iso(s) {
  if (!s) return '';
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [_, d, mo, y] = m;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  return ''; // desconhecido -> vazio, para forçar preenchimento por regra
}

function addMonthsKeepDay(isoDate, months) {
  if (!isoDate) return '';
  const [Y,M,D] = isoDate.split('-').map(n=>parseInt(n,10));
  const dt = new Date(Date.UTC(Y, M-1, D));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth()+1;
  const d = dt.getUTCDate();
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// ----------------- REGRAS ESPECIAIS -----------------
const REGRAS = {
  // MEDGRUPO recorrente — uma DAR/mês (set/out/nov 2025), dia 10, valor fixo
  '30010.592/2024': {
    tipo: 'recorrente_mes',
    inicio: args['med-inicio'],           // 2025-09-10
    valor: Number(args['med-valor']),     // 15530.89
    passo_meses: 1
  },
};

// Pega primeiro valor/vencimento do grupo como âncora
function acharAncoraDoGrupo(lista) {
  // prioriza P1 com valor e vencimento
  let p1 = lista.find(r => String(r.parcela).trim()==='1' && Number.isFinite(r._valorNum) && !!r._vencIso);
  if (p1) return { valor: rNum(p1._valorNum), venc: p1._vencIso };
  // senão, qualquer linha com os dois válidos
  let any = lista.find(r => Number.isFinite(r._valorNum) && !!r._vencIso);
  if (any) return { valor: rNum(any._valorNum), venc: any._vencIso };
  // senão, valor válido
  let v = lista.find(r => Number.isFinite(r._valorNum));
  // e/ou venc válido
  let d = lista.find(r => !!r._vencIso);
  return { valor: v ? rNum(v._valorNum) : NaN, venc: d ? d._vencIso : '' };
}

function rNum(n) { return Number.isFinite(n) ? Number(n) : NaN; }

// aplica regra específica por processo, senão usa âncora do grupo
function preencherLinha(row, grupo, regra) {
  const parcelaN = parseInt(String(row.parcela || '1').trim(), 10) || 1;

  // valor
  if (!(row.valor && String(row.valor).trim())) {
    if (regra && regra.tipo === 'recorrente_mes' && Number.isFinite(regra.valor)) {
      row.valor = String(regra.valor); // gravamos como número simples; o importador aceita
    } else if (Number.isFinite(grupo.ancora.valor)) {
      row.valor = String(grupo.ancora.valor);
    }
  }

  // vencimento
  const vencOK = iso(row.data_vencimento);
  if (!vencOK) {
    if (regra && regra.tipo === 'recorrente_mes' && regra.inicio) {
      // data = inicio + (parcela-1)*passo_meses
      row.data_vencimento = addMonthsKeepDay(regra.inicio, (parcelaN-1)*(regra.passo_meses||1));
    } else if (grupo.ancora.venc) {
      row.data_vencimento = addMonthsKeepDay(grupo.ancora.venc, (parcelaN-1)); // mensal
    }
  }

  // normalização final
  row._valorNum = toNum(row.valor);
  row._vencIso = iso(row.data_vencimento);
  return row;
}

(function main() {
  const csvIn = fs.readFileSync(args.in, 'utf8');
  const delim = detectDelimiter(csvIn);
  let rows = parse(csvIn, { columns: true, skip_empty_lines: true, delimiter: delim });

  // normaliza campos auxiliares e agrupa
  const grupos = {}; // proc -> { linhas: [], ancora: {valor, venc} }
  for (const r of rows) {
    // nomes possíveis vindos do seu CSV:
    const proc = normProc(r.processo_norm || r.processo_plan || r.processo_sistema || r.processo || r.numero_processo);
    r.processo_norm = proc;
    r.parcela = r.parcela || '1';
    r._valorNum = toNum(r.valor);
    r._vencIso  = iso(r.data_vencimento);
    if (!grupos[proc]) grupos[proc] = { linhas: [] };
    grupos[proc].linhas.push(r);
  }

  // calcula âncora por grupo
  for (const [proc, g] of Object.entries(grupos)) {
    g.ancora = acharAncoraDoGrupo(g.linhas);
  }

  // aplica preenchimento
  let preenchidosValor = 0, preenchidosVenc = 0;
  for (const [proc, g] of Object.entries(grupos)) {
    const regra = REGRAS[proc];
    for (const row of g.linhas) {
      const antesV = Number.isFinite(toNum(row.valor));
      const antesD = !!iso(row.data_vencimento);
      preencherLinha(row, g, regra);
      if (!antesV && Number.isFinite(row._valorNum)) preenchidosValor++;
      if (!antesD && !!row._vencIso) preenchidosVenc++;
      // grava de volta em formato que o importador entende
      if (Number.isFinite(row._valorNum)) row.valor = String(row._valorNum); // ponto decimal
      if (row._vencIso) row.data_vencimento = row._vencIso;
    }
  }

  // estatística final
  const faltando = rows.filter(r => !Number.isFinite(toNum(r.valor)) || !iso(r.data_vencimento));
  console.log(`Total linhas: ${rows.length}`);
  console.log(`Preenchidos agora -> valor: ${preenchidosValor}, vencimento: ${preenchidosVenc}`);
  console.log(`Ainda faltando valor/vencimento: ${faltando.length}`);
  if (faltando.length) {
    const byProc = {};
    faltando.forEach(r => {
      byProc[r.processo_norm] = byProc[r.processo_norm] || 0;
      byProc[r.processo_norm]++;
    });
    console.log('Pendências por processo:', byProc);
  }

  const out = stringify(rows, { header: true, delimiter: delim });
  fs.writeFileSync(args.out, out, 'utf8');
  console.log(`Arquivo gerado: ${args.out}`);
})();
