#!/usr/bin/env node
/**
 * Importa e processa DARs conforme plano CSV:
 * - CRIAR+VINCULAR+EMITIR
 * - CRIAR+VINCULAR+MARCAR_PAGO
 * - APENAS_EMITIR
 * - APENAS_MARCAR_PAGO
 * - SEM_ACAO
 *
 * Uso:
 *  node scripts/importar_emitir_por_plano.js \
 *    --csv scripts/plano_final_para_importar_e_emitir.csv \
 *    --map scripts/resolver_map_sugerido.csv \
 *    --api-base http://localhost:3000 \
 *    [--emitir] [--marcar-pago] [--dry-run] \
 *    [--resolver "30010.592/2024=233"] \
 *    [--header "x-bot-key:Secti@2025#"] [--header "Authorization: Bearer <TOKEN>"]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const minimist = require('minimist');
const { parse } = require('csv-parse/sync');

const args = minimist(process.argv.slice(2), {
  string: ['csv','map','api-base','header','resolver'],
  boolean: ['emitir','marcar-pago','dry-run'],
  alias: { h: 'header' },
  default: { emitir: false, 'marcar-pago': false, 'dry-run': true }
});

if (!args['api-base']) {
  console.error('Erro: informe --api-base (ex: http://localhost:3000)');
  process.exit(1);
}
if (!args.csv) {
  console.error('Erro: informe --csv com o plano (ex: scripts/plano_final_para_importar_e_emitir.csv)');
  process.exit(1);
}

const API_BASE = args['api-base'].replace(/\/+$/,''); // sem barra final

// ---------- Headers opcionais ----------
const HEADERS = {};
([].concat(args.header || [])).forEach(h => {
  const idx = String(h).indexOf(':');
  if (idx > 0) {
    const k = h.slice(0,idx).trim();
    const v = h.slice(idx+1).trim();
    HEADERS[k] = v;
  }
});

// ---------- Helpers ----------
function detectDelimiter(sample) {
  const first = (sample.split(/\r?\n/)[0] || '').replace(/\r/g,'');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of Object.keys(counts)) counts[ch] = (first.match(new RegExp('\\' + ch, 'g')) || []).length;
  let best = ',', max = -1;
  for (const [ch, c] of Object.entries(counts)) { if (c > max) { max = c; best = ch; } }
  return best;
}

function toNum(x) {
  if (x === null || x === undefined) return NaN;
  let s = String(x).trim();
  if (!s) return NaN;
  // remove R$, espaços e NBSP
  s = s.replace(/[R$\s\u00A0]/gi, '');
  // vírgula decimal? troca e remove milhares
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
  return t; // deixa como veio (será validado mais adiante)
}

// Normaliza "E:30010.0000000592/2024" -> "30010.592/2024"
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

// pega o primeiro campo não-vazio dentre os nomes passados
function pick(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

// ---------- Resolver (CLI) ----------
let resolver = {};
function addResolverPair(pair){
  if(!pair) return;
  const i = String(pair).indexOf('=');
  if(i <= 0) return;
  const proc = normProc(pair.slice(0,i));
  const id   = String(pair.slice(i+1)).trim();
  if(proc && id) resolver[proc] = id;
}
[].concat(args.resolver || []).forEach(addResolverPair);

// ---------- Axios ----------
const api = axios.create({ baseURL: API_BASE, headers: HEADERS, timeout: 30000 });
api.interceptors.request.use((cfg) => {
  console.log(`→ ${cfg.method?.toUpperCase()} ${cfg.baseURL}${cfg.url}`);
  return cfg;
});

// ---------- Endpoints ----------
async function tryEndpoints(candidates) {
  let lastErr;
  for (const c of candidates) {
    try { return await c(); }
    catch (err) {
      lastErr = err;
      if (err.response && [404,405].includes(err.response.status)) continue;
      continue;
    }
  }
  throw lastErr || new Error('Nenhum endpoint compatível respondeu');
}

async function createAndLinkDAR({ idEvento, numeroParcela, valor, dataVenc }) {
  try {
    const res1 = await tryEndpoints([
      () => api.post(`/eventos/${idEvento}/dars`, { numero_parcela: Number(numeroParcela), valor: Number(valor), data_vencimento: dataVenc }),
      () => api.post(`/eventos/${idEvento}/dars/criar`, { numero_parcela: Number(numeroParcela), valor: Number(valor), data_vencimento: dataVenc }),
    ]);
    const id_dar = res1.data?.id_dar || res1.data?.id || res1.data?.dar_id;
    if (!id_dar) throw new Error('Resposta sem id_dar');
    return id_dar;
  } catch {
    const resCreate = await tryEndpoints([
      () => api.post(`/dars`, { valor: Number(valor), data_vencimento: dataVenc, status: 'Pendente', tipo_permissionario: 'Evento' }),
      () => api.post(`/dars/criar`, { valor: Number(valor), data_vencimento: dataVenc, status: 'Pendente', tipo_permissionario: 'Evento' })
    ]);
    const id_dar = resCreate.data?.id || resCreate.data?.id_dar;
    if (!id_dar) throw new Error('DAR criada mas id não retornado');

    await tryEndpoints([
      () => api.post(`/eventos/${idEvento}/vincular-dar`, { id_dar, numero_parcela: Number(numeroParcela), valor_parcela: Number(valor), data_vencimento: dataVenc }),
      () => api.post(`/dars_eventos`, { id_evento: idEvento, id_dar, numero_parcela: Number(numeroParcela), valor_parcela: Number(valor), data_vencimento: dataVenc })
    ]);
    return id_dar;
  }
}

async function emitirDAR(idDar) {
  const res = await tryEndpoints([
    () => api.post(`/dars/${idDar}/emitir`, {}),
    () => api.post(`/dars/emitir`, { id_dar: idDar }),
  ]);
  return res.data;
}

async function marcarPago(idDar, dataPagamento /* yyyy-mm-dd ou '' */) {
  const payload = dataPagamento ? { status: 'Pago', data_pagamento: dataPagamento } : { status: 'Pago' };
  await tryEndpoints([
    () => api.patch(`/dars/${idDar}`, payload),
    () => api.post(`/dars/${idDar}/pagar`, payload),
    () => api.post(`/dars/${idDar}/baixar`, payload),
  ]);
}

async function findDarInEvento(idEvento, numeroParcela, dataVenc, valor) {
  try {
    const res = await tryEndpoints([
      () => api.get(`/eventos/${idEvento}/dars`),
      () => api.get(`/eventos/${idEvento}/dars/listar`),
    ]);
    const lista = Array.isArray(res.data) ? res.data : (res.data?.dars || []);
    const alvo = lista.find(d =>
      (String(d.numero_parcela) === String(numeroParcela)) &&
      (iso(d.data_vencimento) === iso(dataVenc)) &&
      (Number(d.valor) === Number(valor))
    );
    return alvo?.id || alvo?.id_dar || null;
  } catch {
    return null;
  }
}

// ---------- Carrega CSV do plano ----------
const planoCSV = fs.readFileSync(args.csv, 'utf8');
const delimPlano = detectDelimiter(planoCSV);
const plano = parse(planoCSV, { columns: true, skip_empty_lines: true, delimiter: delimPlano });

// ---------- Mescla resolver do CSV (se existir) ----------
if (args.map && fs.existsSync(args.map)) {
  const mapCSV = fs.readFileSync(args.map, 'utf8');
  const delimMap = detectDelimiter(mapCSV);
  const rows = parse(mapCSV, { columns: true, skip_empty_lines: true, delimiter: delimMap });
  rows.forEach(r => {
    const key = normProc(r.processo_norm || r.processo || r.numero_processo || '');
    const val = r.id_evento && String(r.id_evento).trim();
    if (key && val) resolver[key] = val;
  });
}

// ---------- Loop principal ----------
let m = { criados:0, vinculados:0, emitidos:0, pagos:0, pulados:0, erros:0 };

(async () => {
  for (const row of plano) {
    const processoNorm = normProc(pick(row, 'processo_norm','processo_plan','processo_sistema','processo','numero_processo'));
    const idEventoPlano = pick(row, 'id_evento','evento_id');
    const idEvento = (idEventoPlano ? String(idEventoPlano).trim() : '') || resolver[processoNorm] || '';

    const parcela = String(pick(row, 'parcela','numero_parcela','n_parcela') || '1').trim();

    const valorRaw = pick(row, 'valor','valor_parcela','valor_dar','valorParcela');
    const valor = toNum(valorRaw);

    const vencRaw = pick(row, 'data_vencimento','vencimento','data_venc','venc');
    const venc = iso(vencRaw);

    const pagoPlan = String(pick(row, 'pago_plan','pago','pago?') || 'Nao').toLowerCase().startsWith('s');
    const acao = String(pick(row, 'acao','ação') || '').trim().toUpperCase();
    const obs = pick(row, 'observacao','observação','obs');

    if (!processoNorm) { console.log(`! Sem processo_norm, pulando`); m.pulados++; continue; }
    if (!idEvento) { console.log(`! Evento não resolvido para ${processoNorm} (${obs || 'SEM_OBS'})`); m.pulados++; continue; }
    if (!Number.isFinite(valor) || !venc) { console.log(`! Linha inválida (valor/venc): ${processoNorm} P${parcela}`); m.pulados++; continue; }

    console.log(`\n=== ${processoNorm} | parcela ${parcela} | R$ ${valor.toFixed(2)} | venc ${venc} | ação ${acao}`);

    if (args['dry-run']) continue;

    try {
      let darId = await findDarInEvento(idEvento, parcela, venc, valor);

      if (!darId && (acao.startsWith('CRIAR') || acao==='APENAS_EMITIR' || acao==='APENAS_MARCAR_PAGO')) {
        darId = await createAndLinkDAR({ idEvento, numeroParcela: parcela, valor, dataVenc: venc });
        m.criados++; m.vinculados++;
        console.log(`✓ Criada e vinculada DAR #${darId}`);
      }

      if ((acao.includes('EMITIR') || acao==='APENAS_EMITIR') && args.emitir) {
        if (!darId) throw new Error('Sem id_dar para emitir');
        await emitirDAR(darId);
        m.emitidos++;
        console.log(`✓ Emitida DAR #${darId}`);
      }

      if ((pagoPlan || acao.includes('MARCAR_PAGO') || acao==='APENAS_MARCAR_PAGO') && args['marcar-pago']) {
        if (!darId) throw new Error('Sem id_dar para marcar pago');
        const dataPg = iso(pick(row, 'data_pagamento','pagamento_em','data_pg') || '');
        await marcarPago(darId, dataPg);
        m.pagos++;
        console.log(`✓ Pago DAR #${darId} ${dataPg ? `(data ${dataPg})` : ''}`);
      }

    } catch (err) {
      m.erros++;
      const status = err.response?.status;
      const data = err.response?.data;
      console.error(`✗ Erro na linha: ${status || ''} ${err.message}`);
      if (data) console.error(data);
    }
  }

  console.log('\n--- RESUMO ---');
  console.log(`CRIADOS+VINCULADOS: ${m.criados}/${m.vinculados}`);
  console.log(`EMITIDOS:          ${m.emitidos}`);
  console.log(`PAGOS:             ${m.pagos}`);
  console.log(`PULADOS:           ${m.pulados}`);
  console.log(`ERROS:             ${m.erros}`);
})();
