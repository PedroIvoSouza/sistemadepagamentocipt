#!/usr/bin/env node
/**
 * Saneia e completa o plano:
 * - Preenche valor/vencimento vazios
 * - Regras específicas por processo (ex.: MEDGRUPO recorrente)
 * - Normaliza formatos numéricos e datas
 *
 * Uso:
 *   node scripts/sanar_plano.js \
 *     --in  scripts/plano_final_preenchido.csv \
 *     --out scripts/plano_final_preenchido_fix.csv
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const args = minimist(process.argv.slice(2), {
  string: ['in','out'],
  default: { in: 'plano_final_preenchido.csv', out: 'plano_final_preenchido_fix.csv' }
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
  return ''; // se não reconheci, considero vazio para forçar preenchimento por regra
}

function addMonthsKeepDay(isoDate, months) {
  const [Y,M,D] = isoDate.split('-').map(n=>parseInt(n,10));
  const dt = new Date(Date.UTC(Y, M-1, D));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  // se o mês virou (ex.: 31 -> 30), ajusta para último dia válido
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth()+1;
  const d = dt.getUTCDate();
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// ===== CONFIG DE REGRAS ESPECÍFICAS POR PROCESSO =====
// Você pode adicionar outras entradas aqui conforme necessário.
const REGRAS = {
  // MEDGRUPO recorrente: uma por mês (set, out, nov/2025), vencendo dia 10, valor fixo R$ 15.530,89
  '30010.592/2024': {
    tipo: 'recorrente_mes',
    inicio: '2025-09-10',       // primeira parcela
    parcelas: 3,                // set/out/nov
    valor: 15530.89,            // fixo para cada parcela
    passo_meses: 1              // mensal
  },
  // Exemplo de outra regra:
  // '30010.412/2025': { tipo: 'copiar_de_p1' }
};

// tenta preencher a linha usando regras por processo/parcela
function preencherPorRegra(row, porProcesso) {
  const proc = normProc(row.processo_norm || row.processo_plan || row.processo_sistema || row.processo || row.numero_processo);
  const regra = REGRAS[proc];
  if (!regra) return row;

  const parcela = parseInt(String(row.parcela || '1').trim(), 10) || 1;

  if (regra.tipo === 'recorrente_mes') {
    // valor fixo
    if (!(row.valor && String(row.valor).trim())) row.valor = String(regra.valor).replace('.', ','); // mantém estilo BR se você quiser
    // vencimento calculado a partir da 1ª parcela
    if (!(row.data_vencimento && String(row.data_vencimento).trim())) {
      const base = regra.inicio;
      // parcela 1 => +0 meses, P2 => +1, ...
      const venc = addMonthsKeepDay(base, (parcela-1) * (regra.passo_meses || 1));
      row.data_vencimento = venc;
    }
  }

  if (regra.tipo === 'copiar_de_p1') {
    // encontra P1 do mesmo processo para copiar valor e (se quiser) inferir vencimento
    const L = porProcesso[proc] || [];
    const p1 = L.find(r => String(r.parcela).trim()==='1' && r._valorNum && r._vencIso);
    if (p1) {
      if (!(row.valor && String(row.valor).trim())) row.valor = p1.valor;
      if (!(row.data_vencimento && String(row.data_vencimento).trim())) {
        // exemplo: vencimento P2 = vencimento P1 + 30 dias (ou +1 mês)
        row.data_vencimento = addMonthsKeepDay(p1._vencIso, 1);
      }
    }
  }

  return row;
}

(function main() {
  const csvIn = fs.readFileSync(args.in, 'utf8');
  const delim = detectDelimiter(csvIn);
  let rows = parse(csvIn, { columns: true, skip_empty_lines: true, delimiter: delim });

  // index por processo para possíveis regras de “copiar_de_p1”
  const porProcesso = {};
  rows.forEach(r => {
    const proc = normProc(r.processo_norm || r.processo_plan || r.processo_sistema || r.processo || r.numero_processo);
    if (!porProcesso[proc]) porProcesso[proc] = [];
    // anota parse numérico e iso de venc
    r._valorNum = toNum(r.valor);
    r._vencIso = iso(r.data_vencimento);
    porProcesso[proc].push(r);
  });

  // saneia linha a linha
  rows = rows.map(r => {
    // aplica regra específica (ex.: MEDGRUPO)
    r = preencherPorRegra(r, porProcesso);

    // normaliza formatos finais
    const v = toNum(r.valor);
    const vencIso = iso(r.data_vencimento);

    if (Number.isFinite(v)) {
      // grava como número BR (opcional) ou como número puro; o importador entende ambos
      r.valor = v.toString().replace('.', ','); // mantém vírgula
    }
    if (vencIso) r.data_vencimento = vencIso;

    return r;
  });

  // estatística
  const faltando = rows.filter(r => !Number.isFinite(toNum(r.valor)) || !iso(r.data_vencimento));
  console.log(`Total linhas: ${rows.length}`);
  console.log(`Ainda faltando valor/vencimento: ${faltando.length}`);

  const out = stringify(rows, { header: true, delimiter: delim });
  fs.writeFileSync(args.out, out, 'utf8');
  console.log(`Arquivo gerado: ${args.out}`);
})();
