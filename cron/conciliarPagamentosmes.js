// cron/conciliarPagamentosmes.js  (rotina DIÁRIA 06:00 America/Maceio)
// - Concilia 1 dia por vez (ontem por padrão)
// - Reemissão com juros: chave exata (guia/barras/linha) resolve sem tolerância ampla
// - Sem guia: prioriza referência (ano/mes) + evita vencimento futuro + tie-break por vencimento

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const {
  SQLITE_STORAGE,
  CONCILIACAO_TOLERANCIA_CENTAVOS = '500',
  DEBUG_CONCILIACAO = 'true',
  CONCILIAR_BASE_DIA = 'ontem', // "ontem" (padrão) ou "hoje"
} = process.env;

const DB_PATH = path.resolve(SQLITE_STORAGE || '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db');

const TOL_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 500;
const DBG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const dlog = (...a) => { if (DBG) console.log('[DEBUG]', ...a); };

console.log(`BUILD: conciliarPagamentosmes.js(daily) @ ${new Date().toISOString()} | TOL_BASE=${TOL_BASE}¢ | DEBUG=${DBG}`);

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ------------------------- Helpers -------------------------
function normalizeDoc(s = '') { return String(s).replace(/\D/g, ''); }
function cents(n) { return Math.round(Number(n || 0) * 100); }
function isCNPJ(s = '') { return /^\d{14}$/.test(normalizeDoc(s)); }
function cnpjRoot(s = '') { return normalizeDoc(s).slice(0, 8); }
function SQL_NORM(col) { return `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`; }
function ymd(d) { const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return off.toISOString().slice(0,10); }
function toDateTimeString(date, hh, mm, ss) {
  const yyyy = date.getFullYear();
  const MM   = String(date.getMonth()+1).padStart(2,'0');
  const dd   = String(date.getDate()).padStart(2,'0');
  const HH   = String(hh).padStart(2,'0');
  const mi   = String(mm).padStart(2,'0');
  const ss_  = String(ss).padStart(2,'0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mi}:${ss_}`;
}
function endsWithSufixoGuia(numDoc, guiaNum, minLen = 6) {
  const a = normalizeDoc(numDoc || ''); const b = normalizeDoc(guiaNum || '');
  if (!a || !b) return false;
  const sfx = b.slice(-Math.min(minLen, b.length));
  return a.endsWith(sfx);
}

// ------------------------- DB -------------------------
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[CONCILIA] Erro ao conectar ao banco de dados:', err.message);
    process.exit(1);
  }
});
const dbAll = (sql,p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r||[])));
const dbRun = (sql,p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){ if(e) return rej(e); res(this); }));
const dbGet = (sql,p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));

// ------------------------- Tie-breakers -------------------------
async function applyTiebreakers(cands, guiaNum, dtPgto) {
  let list = (cands || []).slice();

  // 1) Sufixo da guia (se houver)
  if (guiaNum) {
    const bySfx = list.filter(r => endsWithSufixoGuia(r.numero_documento, guiaNum, 6));
    if (bySfx.length === 1) return bySfx[0];
    if (bySfx.length > 1) list = bySfx;
  }

  // 2) Priorizar referência mais antiga (mês/ano)
  list.sort((a,b) => {
    const ka = (a.ano_referencia ?? 9999) * 100 + (a.mes_referencia ?? 99);
    const kb = (b.ano_referencia ?? 9999) * 100 + (b.mes_referencia ?? 99);
    return ka - kb;
  });

  // 3) Dentro da mesma referência, preferir vencimento mais próximo ao pagamento
  if (dtPgto) {
    const base = new Date(String(dtPgto).slice(0,10));
    list.sort((a,b) => {
      const ka = (a.ano_referencia ?? 9999) * 100 + (a.mes_referencia ?? 99);
      const kb = (b.ano_referencia ?? 9999) * 100 + (b.mes_referencia ?? 99);
      if (ka !== kb) return ka - kb;
      const da = new Date(a.data_vencimento || '1970-01-01');
      const db = new Date(b.data_vencimento || '1970-01-01');
      return Math.abs(da - base) - Math.abs(db - base);
    });
  }

  return list[0] || null;
}

async function rankAndTry(rows, tolList, ctxLabel, dtPgto, guiaNum, pagoCents) {
  rows = rows || [];
  dlog(`${ctxLabel}: candidatos pré-tolerância = ${rows.length}`);
  for (const tol of tolList) {
    const candTol = rows.filter(r => Math.abs(Math.round(r.valor*100) - pagoCents) <= tol);
    dlog(`${ctxLabel}: tol=${tol}¢ → ${candTol.length} candidato(s)`);
    if (candTol.length === 1) {
      const r = await dbRun(
        `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,
        [dtPgto || null, candTol[0].id]
      );
      if (r?.changes > 0) return { done:true };
    } else if (candTol.length > 1) {
      const picked = await applyTiebreakers(candTol, guiaNum, dtPgto);
      if (picked) {
        const r = await dbRun(
          `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,
          [dtPgto || null, picked.id]
        );
        if (r?.changes > 0) {
          dlog(`${ctxLabel}: resolveu via tie-breakers (ref/vencimento): id=${picked.id}`);
          return { done:true };
        }
      }
      dlog(`${ctxLabel}: Ambíguo (${candTol.length}). Exemplos:`,
        candTol.slice(0,3).map(x=>({id:x.id,valor:x.valor,numero_documento:x.numero_documento})));
      return { done:false, multi:true };
    }
  }
  return { done:false };
}

// ------------------------- Vinculação -------------------------
async function tentarVincularPagamento(pagamento) {
  const {
    numeroDocOrigem = '',
    numeroGuia = '',
    codigoBarras = '',
    linhaDigitavel = '',
    dataPagamento,
    valorPago = 0,
    numeroInscricao = '',
  } = pagamento;

  const guiaNum = numeroGuia || '';
  const docPagador = normalizeDoc(numeroInscricao || '');
  const pagoCents = cents(valorPago);

  // Tolerância: só 2¢ quando houver chave exata; ampla quando NÃO houver.
  const hasChaveExata = !!(numeroGuia || codigoBarras || linhaDigitavel);
  const tolList = hasChaveExata
    ? [2]  // guia/linha/código -> apenas arredondamento
    : [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents * 0.03))];

  // 0) Tentativas diretas
  const diretas = [
    { label:'id',               sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,                 val: numeroDocOrigem },
    { label:'codigo_barras',    sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE codigo_barras=? AND status!='Pago'`,      val: codigoBarras },
    { label:'linha_digitavel',  sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE linha_digitavel=? AND status!='Pago'`,    val: linhaDigitavel },
    { label:'numero_documento', sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE numero_documento=? AND status!='Pago'`,   val: guiaNum },
  ];
  for (const t of diretas) {
    if (!t.val) continue;
    const r = await dbRun(t.sql, [dataPagamento || null, t.val]);
    dlog(`direta: ${t.label}=${t.val} → changes=${r?.changes || 0}`);
    if (r?.changes > 0) return true;

    // já estava 'Pago'?
    let wherePaid = '';
    if (t.label === 'numero_documento')       wherePaid = `CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER)`;
    else if (t.label === 'codigo_barras' || t.label === 'linha_digitavel') wherePaid = `${t.label} = ?`;
    else if (t.label === 'id')                wherePaid = `id = ?`;

    if (wherePaid) {
      const already = await dbGet(`SELECT id FROM dars WHERE ${wherePaid} AND status='Pago' LIMIT 1`, [t.val]);
      if (already?.id) { console.log(`[INFO] encontrada por ${t.label}=${t.val}, mas já estava 'Pago'.`); return true; }
    }
  }

  // 0.2) equivalências normalizadas
  if (codigoBarras) {
    const cbNorm = normalizeDoc(codigoBarras);
    const r = await dbRun(
      `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento)
         WHERE ${SQL_NORM('codigo_barras')} = ? AND status!='Pago'`,
      [dataPagamento || null, cbNorm]
    );
    dlog(`direta: codigo_barras(num)=${cbNorm} → changes=${r?.changes || 0}`);
    if (r?.changes > 0) return true;
    const already = await dbGet(
      `SELECT id FROM dars WHERE ${SQL_NORM('codigo_barras')} = ? AND status='Pago' LIMIT 1`,
      [cbNorm]
    );
    if (already?.id) { console.log(`[INFO] encontrada por codigo_barras=${codigoBarras}, mas já estava 'Pago'.`); return true; }
  }
  if (guiaNum) {
    const r = await dbRun(
      `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento)
         WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER)
           AND status!='Pago'`,
      [dataPagamento || null, guiaNum]
    );
    dlog(`direta: numero_documento(num)=~${guiaNum} → changes=${r?.changes || 0}`);
    if (r?.changes > 0) return true;
    const already = await dbGet(
      `SELECT id FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) AND status='Pago' LIMIT 1`,
      [guiaNum]
    );
    if (already?.id) { console.log(`[INFO] encontrada por numero_documento=${guiaNum}, mas já estava 'Pago'.`); return true; }
  }

  if (!(valorPago > 0)) return false;

  // Data base para vetar vencimento futuro
  const dataBase = (dataPagamento || ymd(new Date()));

  // 1) Permissionário (CNPJ exato/raiz) + tolerância
  let permIds = [];
  if (isCNPJ(docPagador)) {
    const permExato = await dbGet(`SELECT id FROM permissionarios WHERE ${SQL_NORM('cnpj')} = ? LIMIT 1`, [docPagador]);
    if (permExato?.id) permIds = [permExato.id];
    if (permIds.length === 0) {
      const raiz = cnpjRoot(docPagador);
      const permRaiz = await dbAll(`SELECT id FROM permissionarios WHERE substr(${SQL_NORM('cnpj')},1,8) = ?`, [raiz]);
      if (permRaiz.length === 1) permIds = [permRaiz[0].id];
      else if (permRaiz.length > 1) permIds = permRaiz.map(r => r.id);
    }
  }
  if (permIds.length > 0) {
    const placeholders = permIds.map(()=>'?').join(',');
    const candPerm = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
              d.mes_referencia, d.ano_referencia
         FROM dars d
        WHERE d.permissionario_id IN (${placeholders})
          AND d.status != 'Pago'
          AND date(d.data_vencimento) <= date(?)
        ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
                 ABS(ROUND(d.valor*100) - ?) ASC,
                 d.data_vencimento ASC
        LIMIT 50`,
      [...permIds, dataBase, cents(valorPago)]
    );
    const r = await rankAndTry(candPerm, tolList, 'perm', dataPagamento, guiaNum, cents(valorPago));
    if (r.done || r.multi) return !!r.done;
  }

  // 2) Eventos (doc cliente exato/raiz) + tolerância
  const candEv = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
            d.mes_referencia, d.ano_referencia
       FROM dars d
       JOIN DARs_Eventos de ON de.id_dar = d.id
       JOIN Eventos e       ON e.id = de.id_evento
       JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
      WHERE (
            ${SQL_NORM('ce.documento')} = ?
        OR  (length(${SQL_NORM('ce.documento')})=14 AND substr(${SQL_NORM('ce.documento')},1,8) = ?)
      )
        AND d.status != 'Pago'
        AND date(d.data_vencimento) <= date(?)
      ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
               ABS(ROUND(d.valor*100) - ?) ASC,
               d.data_vencimento ASC
      LIMIT 50`,
    [normalizeDoc(numeroInscricao||''), isCNPJ(numeroInscricao||'') ? cnpjRoot(numeroInscricao) : '__NO_ROOT__', dataBase, cents(valorPago)]
  );
  {
    const r = await rankAndTry(candEv, tolList, 'evento', dataPagamento, guiaNum, cents(valorPago));
    if (r.done || r.multi) return !!r.done;
  }

  // 3) Guia + valor (mesmo número, sem depender do valor exato)
  if (guiaNum) {
    const candGuia = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
              d.mes_referencia, d.ano_referencia
         FROM dars d
        WHERE CAST(${SQL_NORM('d.numero_documento')} AS INTEGER) = CAST(? AS INTEGER)
          AND d.status != 'Pago'
          AND date(d.data_vencimento) <= date(?)
        ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
                 ABS(ROUND(d.valor*100) - ?) ASC,
                 d.data_vencimento ASC
        LIMIT 50`,
      [guiaNum, dataBase, cents(valorPago)]
    );
    const r = await rankAndTry(candGuia, tolList, 'guia+valor', dataPagamento, guiaNum, cents(valorPago));
    if (r.done || r.multi) return !!r.done;
  }

  // 4) LIKE sufixo da guia + valor
  if (guiaNum) {
    const sfx = normalizeDoc(guiaNum).slice(-6);
    if (sfx) {
      const candLike = await dbAll(
        `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
                d.mes_referencia, d.ano_referencia
           FROM dars d
          WHERE ${SQL_NORM('d.numero_documento')} LIKE '%' || ?
            AND d.status != 'Pago'
            AND date(d.data_vencimento) <= date(?)
          ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
                   ABS(ROUND(d.valor*100) - ?) ASC,
                   d.data_vencimento ASC
          LIMIT 50`,
        [sfx, dataBase, cents(valorPago)]
      );
      const r = await rankAndTry(candLike, tolList, 'likeGuia+valor', dataPagamento, guiaNum, cents(valorPago));
      if (r.done || r.multi) return !!r.done;
    }
  }

  // 5) Janela de vencimento ±60d + valor (último recurso)
  const baseDt = dataPagamento ? String(dataPagamento).slice(0,10) : ymd(new Date());
  const maxTol = Math.max(TOL_BASE, Math.round(cents(valorPago) * 0.03));
  const candJan = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
            d.mes_referencia, d.ano_referencia
       FROM dars d
      WHERE d.status != 'Pago'
        AND ABS(ROUND(d.valor*100) - ?) <= ?
        AND ABS(julianday(d.data_vencimento) - julianday(?)) <= 60
        AND date(d.data_vencimento) <= date(?)
      ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
               ABS(ROUND(d.valor*100) - ?) ASC,
               d.data_vencimento ASC
      LIMIT 50`,
    [cents(valorPago), maxTol, baseDt, dataBase, cents(valorPago)]
  );
  dlog(`janela±60d: candidatos = ${candJan.length}`);
  if (candJan.length === 1) {
    const r = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,
      [dataPagamento || null, candJan[0].id]);
    if (r?.changes > 0) return true;
  } else if (candJan.length > 1) {
    const picked = await applyTiebreakers(candJan, guiaNum, dataPagamento);
    if (picked) {
      const r = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,
        [dataPagamento || null, picked.id]);
      if (r?.changes > 0) return true;
    }
  }

  if (guiaNum) {
    const existe = await dbGet(
      `SELECT 1 AS ok FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) LIMIT 1`,
      [guiaNum]
    );
    if (!existe?.ok) console.warn(`[MOTIVO] DAR inexistente no banco para guia=${guiaNum}. Verifique se foi emitida/importada.`);
  }
  return false;
}

// ------------------------- Core diário -------------------------
async function conciliarPagamentosDoDia(dataISO) {
  const dataDia = dataISO || ymd(new Date());
  console.log(`[CONCILIA] Iniciando conciliação do dia ${dataDia}... DB=${DB_PATH}`);

  const dia = new Date(`${dataDia}T00:00:00`);
  const dtHoraInicioDia = toDateTimeString(dia, 0, 0, 0);
  const dtHoraFimDia    = toDateTimeString(dia, 23, 59, 59);

  const pagamentosMap = new Map();

  try {
    // Arrecadação (dia fechado)
    const pagsArr = await listarPagamentosPorDataArrecadacao(dataDia, dataDia);
    for (const p of pagsArr) {
      const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel ||
        `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
      if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
    }
  } catch (e) {
    console.warn(`[CONCILIA] Aviso por-data-arrecadacao(${dataDia}): ${e.message || e}`);
  }

  try {
    // Inclusão (janela 00:00:00~23:59:59)
    const pagsInc = await listarPagamentosPorDataInclusao(dtHoraInicioDia, dtHoraFimDia);
    for (const p of pagsInc) {
      const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel ||
        `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
      if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
    }
  } catch (e) {
    console.warn(`[CONCILIA] Aviso por-data-inclusao(${dataDia}): ${e.message || e}`);
  }

  const todosPagamentos = Array.from(pagamentosMap.values());
  console.log(`[CONCILIA] ${todosPagamentos.length} pagamentos únicos encontrados na SEFAZ para ${dataDia}.`);

  let totalAtualizados = 0;
  for (const pagamento of todosPagamentos) {
    const vinculado = await tentarVincularPagamento(pagamento);
    if (vinculado) {
      console.log(`--> SUCESSO: Pagamento de ${pagamento.numeroInscricao} (Guia: ${pagamento.numeroGuia || '—'}) atualizado p/ 'Pago'.`);
      totalAtualizados++;
    } else {
      console.warn(`--> ALERTA: Pagamento não vinculado. SEFAZ -> Doc: ${pagamento.numeroInscricao}, Guia: ${pagamento.numeroGuia || '—'}, Valor: ${pagamento.valorPago}`);
    }
  }
  console.log(`[CONCILIA] ${dataDia} finalizado. DARs atualizadas: ${totalAtualizados}/${todosPagamentos.length}.`);

  return {
    dataDia,
    totalPagamentos: todosPagamentos.length,
    totalAtualizados,
  };
}

// ------------------------- Lock simples (anti conc. simultânea) -------------------------
const LOCK_FILE = '/tmp/cipt-concilia.lock';
async function withLock(fn) {
  const fdPath = path.resolve(LOCK_FILE);
  let fd;
  try {
    fd = fs.openSync(fdPath, 'wx'); // falha se já existir
  } catch {
    console.warn('[CONCILIA] Outra instância parece estar rodando. Abortando este ciclo.');
    return;
  }
  try {
    await fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(fdPath); } catch {}
  }
}

async function executarConciliacaoDia(dataISO) {
  let resumo = null;
  let executado = false;

  await withLock(async () => {
    executado = true;
    resumo = await conciliarPagamentosDoDia(dataISO);
  });

  return { executado, resumo };
}

// ------------------------- Agendamento diário (06:00) -------------------------
function scheduleConciliacao() {
  cron.schedule('0 6 * * *', async () => {
    const base = new Date();
    if ((CONCILIAR_BASE_DIA || 'ontem').toLowerCase() !== 'hoje') base.setDate(base.getDate()-1);
    const alvo = ymd(base);
    await withLock(() => conciliarPagamentosDoDia(alvo));
  }, { scheduled:true, timezone:'America/Maceio' });

  console.log('[CONCILIA] Agendador diário iniciado (06:00 America/Maceio).');
}

// Execução direta via CLI:
//   node cron/conciliarPagamentosmes.js                -> roda com CONCILIAR_BASE_DIA (padrão ontem)
//   node cron/conciliarPagamentosmes.js --date=2025-08-27
//   node cron/conciliarPagamentosmes.js --range=2025-08-01:2025-08-28
if (require.main === module) {
  const argDate  = (process.argv.find(a=>a.startsWith('--date=')) || '').split('=')[1];
  const argRange = (process.argv.find(a=>a.startsWith('--range='))|| '').split('=')[1];

  const run = async () => {
    if (argRange) {
      const [ini,fim] = argRange.split(':').map(s=>s.trim());
      const d0 = new Date(`${ini}T00:00:00`);
      const d1 = new Date(`${fim}T00:00:00`);
      for (let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)) {
        await withLock(() => conciliarPagamentosDoDia(ymd(d)));
      }
      return;
    }
    if (argDate) {
      await withLock(() => conciliarPagamentosDoDia(argDate));
      return;
    }
    const base = new Date();
    if ((CONCILIAR_BASE_DIA || 'ontem').toLowerCase() !== 'hoje') base.setDate(base.getDate()-1);
    await withLock(() => conciliarPagamentosDoDia(ymd(base)));
  };

  run()
  .catch(e=>{
    console.error('[CONCILIA] ERRO FATAL:', e?.message || e);
    process.exit(1);
  })
  .finally(()=>{
    db.close(err => { if (err) console.error('[CONCILIA] Erro ao fechar DB:', err.message); });
  });
} else {
  module.exports = { scheduleConciliacao, conciliarPagamentosDoDia, executarConciliacaoDia };
}
