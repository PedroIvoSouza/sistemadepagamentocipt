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
 *    [--header "x-bot-key:Secti@2025#"] [--header "Authorization: Bearer <TOKEN>"]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const minimist = require('minimist');
const { parse } = require('csv-parse/sync');

const args = minimist(process.argv.slice(2), {
  string: ['csv','map','api-base','header','resolver'], // <- incluir resolver como string
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
const HEADERS = {};
([].concat(args.header || [])).forEach(h => {
  const idx = String(h).indexOf(':');
  if (idx > 0) {
    const k = h.slice(0,idx).trim();
    const v = h.slice(idx+1).trim();
    HEADERS[k] = v;
  }
});

function toNum(x) {
  if (x === null || x === undefined || x === '') return NaN;
  const s = String(x).replace(',','.');
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : NaN;
}

function iso(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  const m2 = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) {
    const [_, d, mo, y] = m2;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  return s;
}

// --- normalizador de processo (sem if/guard) ---
function normProc(s) {
  if (!s) return '';
  let up = String(s).toUpperCase().trim();
  up = up.replace(/^E:/,'').replace(/\s+/g,'');
  const m = up.match(/^(\d+)\.(\d+)\/(\d{4})$/);
  if (!m) {
    const m2 = up.match(/^.*?(\d{4})$/);
    const ano = m2 ? m2[1] : null;
    let base = null, seq = null;
    const baseSeq = up.replace(/\/?\d{4}$/,'');
    if (baseSeq.includes('.')) {
      [base, seq] = baseSeq.split('.');
    }
    if (seq) seq = seq.replace(/^0+/,'') || '0';
    return (base && ano) ? `${base}.${seq}/${ano}` : up;
  }
  const [, base, seq, ano] = m;
  const seqn = String(seq).replace(/^0+/,'') || '0';
  return `${base}.${seqn}/${ano}`;
}

// --- suporte a --resolver PROC=ID (pode repetir a flag) ---
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
  
// Axios com interceptor de log
const api = axios.create({ baseURL: API_BASE, headers: HEADERS, timeout: 30000 });
api.interceptors.request.use((cfg) => {
  console.log(`→ ${cfg.method?.toUpperCase()} ${cfg.baseURL}${cfg.url}`);
  return cfg;
});

// Tentativa de múltiplos endpoints (fallback)
async function tryEndpoints(candidates) {
  let lastErr;
  for (const c of candidates) {
    try {
      const res = await c();
      return res;
    } catch (err) {
      lastErr = err;
      // Se 404/405, tenta próximo
      if (err.response && [404,405].includes(err.response.status)) continue;
      // outros erros (500 etc.) também merecem tentar o próximo
      continue;
    }
  }
  throw lastErr || new Error('Nenhum endpoint compatível respondeu');
}

// Criar + vincular DAR a um Evento
async function createAndLinkDAR({ idEvento, numeroParcela, valor, dataVenc }) {
  // 1) Tenta endpoint que já cria e vincula
  try {
    const res1 = await tryEndpoints([
      () => api.post(`/eventos/${idEvento}/dars`, {
        numero_parcela: Number(numeroParcela),
        valor: Number(valor),
        data_vencimento: dataVenc
      }),
      () => api.post(`/eventos/${idEvento}/dars/criar`, {
        numero_parcela: Number(numeroParcela),
        valor: Number(valor),
        data_vencimento: dataVenc
      }),
    ]);
    // esperar { id_dar, ... } na resposta
    const id_dar = res1.data?.id_dar || res1.data?.id || res1.data?.dar_id;
    if (!id_dar) throw new Error('Resposta sem id_dar');
    return id_dar;
  } catch (_) {
    // 2) Fallback em 2 etapas: criar DAR e depois vincular
    const resCreate = await tryEndpoints([
      () => api.post(`/dars`, {
        valor: Number(valor),
        data_vencimento: dataVenc,
        status: 'Pendente',
        tipo_permissionario: 'Evento' // útil pro seu schema
      }),
      () => api.post(`/dars/criar`, {
        valor: Number(valor),
        data_vencimento: dataVenc,
        status: 'Pendente',
        tipo_permissionario: 'Evento'
      })
    ]);
    const id_dar = resCreate.data?.id || resCreate.data?.id_dar;
    if (!id_dar) throw new Error('DAR criada mas id não retornado');

    // Vincular
    await tryEndpoints([
      () => api.post(`/eventos/${idEvento}/vincular-dar`, {
        id_dar: id_dar,
        numero_parcela: Number(numeroParcela),
        valor_parcela: Number(valor),
        data_vencimento: dataVenc
      }),
      () => api.post(`/dars_eventos`, {
        id_evento: idEvento,
        id_dar: id_dar,
        numero_parcela: Number(numeroParcela),
        valor_parcela: Number(valor),
        data_vencimento: dataVenc
      })
    ]);
    return id_dar;
  }
}

// Emitir DAR
async function emitirDAR(idDar) {
  const res = await tryEndpoints([
    () => api.post(`/dars/${idDar}/emitir`, {}),
    () => api.post(`/dars/emitir`, { id_dar: idDar }),
  ]);
  return res.data;
}

// Marcar Pago
async function marcarPago(idDar, dataPagamento /* yyyy-mm-dd ou '' */) {
  const payload = dataPagamento ? { status: 'Pago', data_pagamento: dataPagamento } : { status: 'Pago' };
  await tryEndpoints([
    () => api.patch(`/dars/${idDar}`, payload),
    () => api.post(`/dars/${idDar}/pagar`, payload),
    () => api.post(`/dars/${idDar}/baixar`, payload),
  ]);
}

// Buscar DAR existente para um evento (parcela/venc/valor)
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

// --------- Carrega CSVs ---------
const planoCSV = fs.readFileSync(args.csv, 'utf8');
const plano = parse(planoCSV, { columns: true, skip_empty_lines: true });

// mescla os mapeamentos do arquivo no objeto resolver existente
if (args.map && fs.existsSync(args.map)) {
  const mapCSV = fs.readFileSync(args.map, 'utf8');
  const rows = parse(mapCSV, { columns: true, skip_empty_lines: true });
  rows.forEach(r => {
    const key = normProc(r.processo_norm || r.processo || r.numero_processo || '');
    const val = r.id_evento && String(r.id_evento).trim();
    if (key && val) resolver[key] = val;
  });
}

// métricas
let m = { criados:0, vinculados:0, emitidos:0, pagos:0, pulados:0, erros:0 };

// --------- Loop principal ---------
(async () => {
  for (const row of plano) {
    const processoNorm = normProc(row.processo_norm || row.processo_plan || row.processo_sistema || '');
    const idEventoPlano = row.id_evento ? String(row.id_evento).trim() : '';
    const idEvento = idEventoPlano || resolver[processoNorm] || '';

    const parcela = String(row.parcela || '1').trim();
    const valor = toNum(row.valor);
    const venc = iso(row.data_vencimento);
    const acao = String(row.acao || '').trim().toUpperCase();
    const pagoPlan = String(row.pago_plan || 'Não').toLowerCase() === 'sim';
    const obs = row.observacao || '';

    if (!processoNorm) { console.log(`! Sem processo_norm, pulando`); m.pulados++; continue; }
    if (!idEvento) { console.log(`! Evento não resolvido para ${processoNorm} (${obs})`); m.pulados++; continue; }
    if (!Number.isFinite(valor) || !venc) { console.log(`! Linha inválida (valor/venc): ${processoNorm} P${parcela}`); m.pulados++; continue; }

    console.log(`\n=== ${processoNorm} | parcela ${parcela} | R$ ${valor.toFixed(2)} | venc ${venc} | ação ${acao}`);

    // DRY-RUN?
    if (args['dry-run']) { continue; }

    try {
      // localizar DAR existente
      let darId = null;
      darId = await findDarInEvento(idEvento, parcela, venc, valor);

      if (!darId && (acao.startsWith('CRIAR') || acao==='APENAS_EMITIR' || acao==='APENAS_MARCAR_PAGO')) {
        // cria + vincula
        darId = await createAndLinkDAR({ idEvento, numeroParcela: parcela, valor, dataVenc: venc });
        m.criados++; m.vinculados++;
        console.log(`✓ Criada e vinculada DAR #${darId}`);
      }

      // emitir quando necessário
      if ((acao.includes('EMITIR') || acao==='APENAS_EMITIR') && args.emitir) {
        if (!darId) throw new Error('Sem id_dar para emitir');
        await emitirDAR(darId);
        m.emitidos++;
        console.log(`✓ Emitida DAR #${darId}`);
      }

      // marcar pago quando necessário
      if ((pagoPlan || acao.includes('MARCAR_PAGO') || acao==='APENAS_MARCAR_PAGO') && args['marcar-pago']) {
        if (!darId) throw new Error('Sem id_dar para marcar pago');
        const dataPg = iso(row.data_pagamento || ''); // se vier no plano
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
