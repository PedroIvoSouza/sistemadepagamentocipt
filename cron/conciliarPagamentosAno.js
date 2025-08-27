// Em: cron/conciliarPagamentosAno.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();

const {
  DB_PATH = '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db',
  CONCILIACAO_TOLERANCIA_CENTAVOS = '500', // 5 reais
  DEBUG_CONCILIACAO = 'true',
} = process.env;

const TOL_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 500;
const DBG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const dlog = (...a) => { if (DBG) console.log('[DEBUG]', ...a); };

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ============== Helpers ==============
function normalizeDoc(s = '') { return String(s).replace(/\D/g, ''); }
function cents(n) { return Math.round(Number(n || 0) * 100); }
function isCNPJ(s = '') { return /^\d{14}$/.test(normalizeDoc(s)); }
function cnpjRoot(s = '') { return normalizeDoc(s).slice(0, 8); }
function SQL_NORM(col) { return `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`; }
function endsWithSufixoGuia(numDoc, guiaNum, minLen = 6) {
  const a = normalizeDoc(numDoc || '');
  const b = normalizeDoc(guiaNum || '');
  if (!a || !b) return false;
  const sfx = b.slice(-Math.min(minLen, b.length));
  return a.endsWith(sfx);
}
function ymd(d) { const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return off.toISOString().slice(0,10); }
function toDateTimeString(date, hh, mm, ss) {
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth()+1).padStart(2,'0');
  const dd = String(date.getDate()).padStart(2,'0');
  const HH = String(hh).padStart(2,'0');
  const mm_ = String(mm).padStart(2,'0');
  const ss_ = String(ss).padStart(2,'0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mm_}:${ss_}`;
}

// ============== DB ==============
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('[CONCILIA-ANO] Erro ao conectar ao DB:', err.message); process.exit(1); }
});
const dbAll = (sql,p=[])=>new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r||[])));
const dbRun = (sql,p=[])=>new Promise((res,rej)=>db.run(sql,p,function(e){e?rej(e):res(this)}));
const dbGet = (sql,p=[])=>new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));

// ============== Tie-breakers ==============
async function applyTiebreakers(cands, guiaNum, dtPgto) {
  let list = (cands||[]).slice();
  if (guiaNum) {
    const bySfx = list.filter(r => endsWithSufixoGuia(r.numero_documento, guiaNum, 6));
    if (bySfx.length === 1) return bySfx[0];
    if (bySfx.length > 1) list = bySfx;
  }
  if (dtPgto && list.length > 1) {
    const base = new Date(String(dtPgto).slice(0,10));
    list.sort((a,b)=>{
      const da = new Date(a.data_vencimento||'1970-01-01');
      const db = new Date(b.data_vencimento||'1970-01-01');
      return Math.abs(da-base) - Math.abs(db-base);
    });
    const best = list[0], second = list[1];
    if (!second) return best;
    const baseTs = base.getTime();
    const diff1 = Math.abs(new Date(best.data_vencimento||'1970-01-01') - baseTs);
    const diff2 = Math.abs(new Date(second.data_vencimento||'1970-01-01') - baseTs);
    if (diff1 < diff2) return best;
  }
  return null;
}

async function rankAndTry(rows, tolList, ctxLabel, dtPgto, guiaNum, pagoCents) {
  rows = rows || [];
  dlog(`${ctxLabel}: pré-tol=${rows.length}`);
  for (const tol of tolList) {
    const candTol = rows.filter(r => Math.abs(Math.round(r.valor*100) - pagoCents) <= tol);
    dlog(`${ctxLabel}: tol=${tol}¢ → ${candTol.length}`);
    if (candTol.length === 1) {
      const r = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
        [dtPgto||null, candTol[0].id]);
      if (r?.changes>0) return {done:true};
    } else if (candTol.length > 1) {
      const picked = await applyTiebreakers(candTol, guiaNum, dtPgto);
      if (picked) {
        const r = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
          [dtPgto||null, picked.id]);
        if (r?.changes>0) return {done:true};
      }
      dlog(`${ctxLabel}: ambíguo (${candTol.length})`);
      return {done:false, multi:true};
    }
  }
  return {done:false};
}

// ============== Conciliação por pagamento ==============
async function tentarVincularPagamento(p) {
  const {
    numeroDocOrigem = '',
    numeroGuia = '',
    codigoBarras = '',
    linhaDigitavel = '',
    dataPagamento,
    valorPago = 0,
    numeroInscricao = '',
  } = p;

  const guiaNum = numeroGuia || '';
  const docPagador = normalizeDoc(numeroInscricao || '');
  const pagoCents = cents(valorPago);
  const tolList = [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents*0.03))];

  // 0) tentativas diretas
  const diretas = [
    { label:'id',              sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,              val: numeroDocOrigem },
    { label:'codigo_barras',   sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE codigo_barras=? AND status!='Pago'`,   val: codigoBarras },
    { label:'linha_digitavel', sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE linha_digitavel=? AND status!='Pago'`, val: linhaDigitavel },
    { label:'numero_documento',sql:`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE numero_documento=? AND status!='Pago'`,val: guiaNum },
  ];
  for (const t of diretas) {
    if (!t.val) continue;
    const r = await dbRun(t.sql, [dataPagamento||null, t.val]);
    dlog(`direta: ${t.label}=${t.val} → changes=${r?.changes||0}`);
    if (r?.changes>0) return true;

    // já estava pago?
    let wherePaid = '';
    if (t.label === 'numero_documento') wherePaid = `CAST(${SQL_NORM('numero_documento')} AS INTEGER)=CAST(? AS INTEGER)`;
    else if (t.label === 'codigo_barras' || t.label === 'linha_digitavel') wherePaid = `${t.label}=?`;
    else if (t.label === 'id') wherePaid = `id=?`;
    if (wherePaid) {
      const already = await dbGet(`SELECT id FROM dars WHERE ${wherePaid} AND status='Pago' LIMIT 1`, [t.val]);
      if (already?.id) return true;
    }
  }

  // normalizações
  if (codigoBarras) {
    const cb = normalizeDoc(codigoBarras);
    const r = await dbRun(
      `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento)
       WHERE ${SQL_NORM('codigo_barras')}=? AND status!='Pago'`,
      [dataPagamento||null, cb]);
    if (r?.changes>0) return true;
    const already = await dbGet(
      `SELECT id FROM dars WHERE ${SQL_NORM('codigo_barras')}=? AND status='Pago' LIMIT 1`, [cb]);
    if (already?.id) return true;
  }
  if (guiaNum) {
    const r = await dbRun(
      `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento)
       WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER)=CAST(? AS INTEGER) AND status!='Pago'`,
      [dataPagamento||null, guiaNum]);
    if (r?.changes>0) return true;
    const already = await dbGet(
      `SELECT id FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER)=CAST(? AS INTEGER) AND status='Pago' LIMIT 1`,
      [guiaNum]);
    if (already?.id) return true;
  }
  if (!(valorPago>0)) return false;

  // 1) permissionário por CNPJ exato/raiz
  let permIds = [];
  if (isCNPJ(docPagador)) {
    const exato = await dbGet(
      `SELECT id FROM permissionarios WHERE ${SQL_NORM('cnpj')}=? LIMIT 1`, [docPagador]);
    if (exato?.id) permIds=[exato.id];
    if (permIds.length===0) {
      const raiz = cnpjRoot(docPagador);
      const arr = await dbAll(
        `SELECT id FROM permissionarios WHERE substr(${SQL_NORM('cnpj')},1,8)=?`, [raiz]);
      if (arr.length===1) permIds=[arr[0].id];
      else if (arr.length>1) permIds=arr.map(r=>r.id);
    }
  }
  if (permIds.length>0) {
    const placeholders = permIds.map(()=>'?').join(',');
    const cand = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
       FROM dars d
       WHERE d.permissionario_id IN (${placeholders}) AND d.status!='Pago'
       ORDER BY ABS(ROUND(d.valor*100)-?) ASC, d.data_vencimento ASC
       LIMIT 50`, [...permIds, cents(valorPago)]);
    const r = await rankAndTry(cand, [2, TOL_BASE, Math.max(TOL_BASE, Math.round(cents(valorPago)*0.03))],
      'perm', dataPagamento, guiaNum, cents(valorPago));
    if (r.done || r.multi) return !!r.done;
  }

  // 2) eventos/Clientes_Eventos por documento exato/raiz
  const candEv = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
     FROM dars d
     JOIN DARs_Eventos de ON de.id_dar=d.id
     JOIN Eventos e ON e.id=de.id_evento
     JOIN Clientes_Eventos ce ON ce.id=e.id_cliente
     WHERE (
            ${SQL_NORM('ce.documento')}=?
         OR (length(${SQL_NORM('ce.documento')})=14 AND substr(${SQL_NORM('ce.documento')},1,8)=?)
     )
     AND d.status!='Pago'
     ORDER BY ABS(ROUND(d.valor*100)-?) ASC, d.data_vencimento ASC
     LIMIT 50`,
     [normalizeDoc(numeroInscricao||''), isCNPJ(numeroInscricao||'') ? cnpjRoot(numeroInscricao) : '__NO__', cents(valorPago)]
  );
  {
    const r = await rankAndTry(candEv, [2, TOL_BASE, Math.max(TOL_BASE, Math.round(cents(valorPago)*0.03))],
      'evento', dataPagamento, guiaNum, cents(valorPago));
    if (r.done || r.multi) return !!r.done;
  }

  // 3) guia + valor
  if (guiaNum) {
    const candGuia = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
       FROM dars d
       WHERE CAST(${SQL_NORM('d.numero_documento')} AS INTEGER)=CAST(? AS INTEGER)
         AND d.status!='Pago'
       ORDER BY ABS(ROUND(d.valor*100)-?) ASC, d.data_vencimento ASC
       LIMIT 50`,
      [guiaNum, cents(valorPago)]
    );
    const r = await rankAndTry(candGuia, [2, TOL_BASE, Math.max(TOL_BASE, Math.round(cents(valorPago)*0.03))],
      'guia+valor', dataPagamento, guiaNum, cents(valorPago));
    if (r.done || r.multi) return !!r.done;
  }

  // 4) like sufixo guia + valor
  if (guiaNum) {
    const sfx = normalizeDoc(guiaNum).slice(-6);
    if (sfx) {
      const candLike = await dbAll(
        `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
         WHERE ${SQL_NORM('d.numero_documento')} LIKE '%' || ?
           AND d.status!='Pago'
         ORDER BY ABS(ROUND(d.valor*100)-?) ASC, d.data_vencimento ASC
         LIMIT 50`,
        [sfx, cents(valorPago)]
      );
      const r = await rankAndTry(candLike, [2, TOL_BASE, Math.max(TOL_BASE, Math.round(cents(valorPago)*0.03))],
        'likeGuia+valor', dataPagamento, guiaNum, cents(valorPago));
      if (r.done || r.multi) return !!r.done;
    }
  }

  // 5) janela ±60d + valor
  const baseDt = dataPagamento ? String(dataPagamento).slice(0,10) : ymd(new Date());
  const maxTol = Math.max(TOL_BASE, Math.round(cents(valorPago)*0.03));
  const candJan = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
     FROM dars d
     WHERE d.status!='Pago'
       AND ABS(ROUND(d.valor*100)-?) <= ?
       AND ABS(julianday(d.data_vencimento) - julianday(?)) <= 60
     ORDER BY ABS(ROUND(d.valor*100)-?) ASC, d.data_vencimento ASC
     LIMIT 50`,
    [cents(valorPago), maxTol, baseDt, cents(valorPago)]
  );
  if (candJan.length===1) {
    const r = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
      [dataPagamento||null, candJan[0].id]);
    if (r?.changes>0) return true;
  } else if (candJan.length>1) {
    const picked = await applyTiebreakers(candJan, guiaNum, dataPagamento);
    if (picked) {
      const r = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
        [dataPagamento||null, picked.id]);
      if (r?.changes>0) return true;
    }
  }

  // diagnóstico: DAR inexistente?
  if (guiaNum) {
    const existe = await dbGet(
      `SELECT 1 ok FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER)=CAST(? AS INTEGER) LIMIT 1`, [guiaNum]);
    if (!existe?.ok) console.warn(`[MOTIVO] DAR inexistente no banco para guia=${guiaNum}`);
  }
  return false;
}

// ============== Runner (Ano) ==============
function getRangeAno(ano) {
  const y = Number(ano) || (new Date().getFullYear());
  const start = new Date(y, 0, 1);
  const now = new Date();
  const end = (y === now.getFullYear()) ? now : new Date(y, 11, 31, 23, 59, 59);
  return { y, start, end };
}

async function conciliarPagamentosDoAno(ano) {
  const { y, start, end } = getRangeAno(ano);
  console.log(`[CONCILIA-ANO] Iniciando conciliação de ${y} (${ymd(start)} a ${ymd(end)})… DB=${DB_PATH}`);

  const pagamentosMap = new Map();
  for (let dia = new Date(start); dia <= end; dia.setDate(dia.getDate() + 1)) {
    const dataDia = ymd(dia);
    const dtIni = toDateTimeString(dia, 0, 0, 0);
    const dtFim = toDateTimeString(dia, 23, 59, 59);

    // 1) arrecadação
    try {
      const pagsArrec = await listarPagamentosPorDataArrecadacao(dataDia, dataDia);
      for (const p of pagsArrec) {
        const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel || `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento||''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) { console.warn(`[ARREC] ${dataDia}: ${e.message||e}`); }

    // 2) inclusão
    try {
      const pagsInc = await listarPagamentosPorDataInclusao(dtIni, dtFim);
      for (const p of pagsInc) {
        const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel || `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento||''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) { console.warn(`[INCL] ${dataDia}: ${e.message||e}`); }
  }

  const todos = Array.from(pagamentosMap.values());
  console.log(`[CONCILIA-ANO] Pagamentos únicos na SEFAZ no ano ${y}: ${todos.length}`);
  let atualizados = 0;

  for (const pagamento of todos) {
    const ok = await tentarVincularPagamento(pagamento);
    if (ok) { atualizados++; }
    else {
      console.warn(`--> NÃO VINCULADO: CNPJ/CPF=${pagamento.numeroInscricao} Guia=${pagamento.numeroGuia||'—'} Valor=${pagamento.valorPago}`);
    }
  }
  console.log(`[CONCILIA-ANO] DARs atualizadas p/ 'Pago': ${atualizados}`);

  // Atualizar status de Eventos quitados no ano
  const { countQuitados, ids } = await atualizarStatusEventosQuitadosNoAno(y);
  console.log(`[EVENTOS] Atualizados para 'Pago' (quitados no ano ${y}): ${countQuitados} evento(s). IDs: ${ids.join(', ') || '—'}`);
}

// ============== Atualização de status de Eventos ==============
async function atualizarStatusEventosQuitadosNoAno(ano) {
  const y = Number(ano) || (new Date().getFullYear());
  const ini = `${y}-01-01`;
  const fim = `${y}-12-31`;

  // Eventos com TODAS as suas DARs pagas; última data_pagamento dentro do ano
  const rows = await dbAll(
    `WITH ev AS (
       SELECT
         e.id                AS evento_id,
         e.nome_evento,
         e.valor_final,
         COUNT(de.id_dar)    AS qtd_parcelas,
         SUM(CASE WHEN d.status='Pago' THEN 1 ELSE 0 END) AS qtd_pagas,
         SUM(de.valor_parcela)                              AS total_parcelas,
         SUM(CASE WHEN d.status='Pago' THEN de.valor_parcela ELSE 0 END) AS total_pago,
         MAX(date(d.data_pagamento)) AS ultima_data_pagamento
       FROM Eventos e
       JOIN DARs_Eventos de ON de.id_evento = e.id
       JOIN dars d          ON d.id = de.id_dar
       GROUP BY e.id
     )
     SELECT *
     FROM ev
     WHERE qtd_parcelas>0
       AND qtd_parcelas = qtd_pagas
       AND date(ultima_data_pagamento) BETWEEN ? AND ?`,
    [ini, fim]
  );

  const ids = rows.map(r => r.evento_id);
  if (ids.length > 0) {
    const placeholders = ids.map(()=>'?').join(',');
    await dbRun(`UPDATE Eventos SET status='Pago' WHERE id IN (${placeholders})`, ids);
  }
  return { countQuitados: ids.length, ids, detalhes: rows };
}

// ============== CLI ==============
if (require.main === module) {
  const argAno = process.argv.find(a => /^--ano=/.test(a));
  const ano = argAno ? Number(argAno.split('=')[1]) : undefined;

  conciliarPagamentosDoAno(ano)
    .catch(e => { console.error('[FATAL] ', e.message||e); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { conciliarPagamentosDoAno, atualizarStatusEventosQuitadosNoAno };
