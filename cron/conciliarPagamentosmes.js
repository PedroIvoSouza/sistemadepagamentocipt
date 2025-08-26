// Em: cron/conciliarPagamentosmes.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const {
  DB_PATH = '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db',
  RECEITA_CODIGO_PERMISSIONARIO,
  RECEITA_CODIGO_EVENTO,
  CONCILIACAO_TOLERANCIA_CENTAVOS = '500',  // default 5 reais
  DEBUG_CONCILIACAO = 'true',
} = process.env;

const TOL_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 500;
const DBG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const dlog = (...a) => { if (DBG) console.log('[DEBUG]', ...a); };
console.log(`BUILD: conciliarPagamentosmes.js @ ${new Date().toISOString()} | TOL_BASE=${TOL_BASE}¢ | DEBUG=${DBG}`);

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ==========================
// Helpers
// ==========================
function normalizeDoc(s = '') { return String(s).replace(/\D/g, ''); }
function cents(n) { return Math.round(Number(n || 0) * 100); }
function isCNPJ(s='') { return /^\d{14}$/.test(normalizeDoc(s)); }
function cnpjRoot(s='') { return normalizeDoc(s).slice(0, 8); } // 8 dígitos iniciais
const SQL_NORM = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`;
function ymd(d) {
  const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 10);
}
function toDateTimeString(date, hh, mm, ss) {
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const HH = String(hh).padStart(2, '0');
  const mm_ = String(mm).padStart(2, '0');
  const ss_ = String(ss).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mm_}:${ss_}`;
}
function addDays(isoYYYYMMDD, days) {
  const [Y, M, D] = String(isoYYYYMMDD).slice(0,10).split('-').map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(dt);
}
function endsWithSufixoGuia(numDoc, guiaNum, minLen = 6) {
  const a = normalizeDoc(numDoc || '');
  const b = normalizeDoc(guiaNum || '');
  if (!a || !b) return false;
  const sfx = b.slice(-Math.min(minLen, b.length));
  return a.endsWith(sfx);
}

async function applyTiebreakers(cands, guiaNum, dtPgto) {
  let list = cands.slice();

  // TB1: sufixo de guia (6 dígitos)
  if (guiaNum) {
    const bySfx = list.filter(r => endsWithSufixoGuia(r.numero_documento, guiaNum, 6));
    if (bySfx.length === 1) return bySfx[0];
    if (bySfx.length > 1) list = bySfx; // restringe o conjunto
  }

  // TB2: vencimento mais próximo da data do pagamento
  if (dtPgto && list.length > 1) {
    const base = new Date(String(dtPgto).slice(0, 10));
    list.sort((a, b) => {
      const da = new Date(a.data_vencimento || '1970-01-01');
      const db = new Date(b.data_vencimento || '1970-01-01');
      return Math.abs(da - base) - Math.abs(db - base);
    });
    // Só escolhe se há um claro primeiro lugar
    const best = list[0];
    const second = list[1];
    if (!second) return best;
    const baseTs = new Date(String(dtPgto).slice(0, 10)).getTime();
    const diff1 = Math.abs(new Date(best.data_vencimento || '1970-01-01') - baseTs);
    const diff2 = Math.abs(new Date(second.data_vencimento || '1970-01-01') - baseTs);
    if (diff1 < diff2) return best;
  }

  return null; // continua ambíguo
}
// ==========================
// DB
// ==========================
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[CONCILIA] Erro ao conectar ao banco de dados:', err.message);
    process.exit(1);
  }
});

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// ==========================
// (Opcional) Receitas (não usadas enquanto "puxamos tudo")
// ==========================
function receitasAtivas() {
  const set = new Set();
  [RECEITA_CODIGO_PERMISSIONARIO, RECEITA_CODIGO_EVENTO].forEach(envVar => {
    if (envVar) {
      const cod = Number(normalizeDoc(envVar));
      if (cod) set.add(cod);
      else throw new Error(`Código de receita inválido no .env: ${envVar}`);
    }
  });
  return Array.from(set);
}

// ==========================
// Núcleo de conciliação
// ==========================

async function tryUpdateByWhere(label, whereSql, whereParams, dtPgto) {
  const sqlUpd = `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE (${whereSql}) AND status!='Pago'`;
  const res = await dbRun(sqlUpd, [dtPgto || null, ...whereParams]);
  dlog(`direta: ${label} → changes=${res?.changes || 0}`);
  if (res?.changes > 0) return { updated: true, alreadyPaid: false };

  // já estava pago?
  const row = await dbGet(`SELECT id FROM dars WHERE (${whereSql}) AND status='Pago' LIMIT 1`, whereParams);
  if (row?.id) return { updated: false, alreadyPaid: true };
  return { updated: false, alreadyPaid: false };
}

async function rankAndTry(rows, tolList, ctxLabel, dtPgto, guiaNum) {
  dlog(`${ctxLabel}: candidatos pré-tolerância = ${rows.length}`);
  rows = rows || [];
  rows._pagoCents = rows._pagoCents ?? 0; // garantia

  for (const tol of tolList) {
    const candTol = rows.filter(r => Math.abs(Math.round(r.valor * 100) - rows._pagoCents) <= tol);
    dlog(`${ctxLabel}: tol=${tol}¢ → ${candTol.length} candidato(s)`);
    if (candTol.length === 1) {
      const r = await dbRun(
        `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
        [dtPgto || null, candTol[0].id]
      );
      if (r?.changes > 0) return { done: true };
    } else if (candTol.length > 1) {
      // TIE-BREAKERS
      const picked = await applyTiebreakers(candTol, guiaNum, dtPgto);
      if (picked) {
        const r = await dbRun(
          `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
          [dtPgto || null, picked.id]
        );
        if (r?.changes > 0) {
          dlog(`${ctxLabel}: resolveu via tie-breakers (sufixo/vencimento): id=${picked.id}`);
          return { done: true };
        }
      }
      dlog(`${ctxLabel}: Ambíguo (${candTol.length}). Exemplos:`,
           candTol.slice(0, 3).map(x => ({ id: x.id, valor: x.valor, numero_documento: x.numero_documento })));
      return { done: false, multi: true };
    }
  }
  return { done: false };
}
/**
 * Tenta vincular um pagamento a uma DAR. Retorna true se atualizou (ou já estava Pago).
 */
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

  const docPagador = normalizeDoc(numeroInscricao || '');
  const guiaNum = normalizeDoc(numeroGuia || '');
  const barrasNum = normalizeDoc(codigoBarras || '');
  const linhaNum = normalizeDoc(linhaDigitavel || '');
  const pagoCents = cents(valorPago);
  const tolList = [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents * 0.03))];

  // 0) Tentativas diretas (id / campos exatos / normalizados)
  {
    const attempts = [];
    if (numeroDocOrigem) attempts.push({ label: `id=${numeroDocOrigem}`, where: `id = ?`, params: [numeroDocOrigem] });
    if (codigoBarras)    attempts.push({ label: `codigo_barras=${codigoBarras}`, where: `codigo_barras = ?`, params: [codigoBarras] });
    if (linhaDigitavel)  attempts.push({ label: `linha_digitavel=${linhaDigitavel}`, where: `linha_digitavel = ?`, params: [linhaDigitavel] });
    if (numeroGuia)      attempts.push({ label: `numero_documento=${numeroGuia}`, where: `numero_documento = ?`, params: [numeroGuia] });
    if (barrasNum)       attempts.push({ label: `codigo_barras(num)=${barrasNum}`, where: `${SQL_NORM('codigo_barras')} = ?`, params: [barrasNum] });
    if (linhaNum)        attempts.push({ label: `linha_digitavel(num)=${linhaNum}`, where: `${SQL_NORM('linha_digitavel')} = ?`, params: [linhaNum] });
    if (guiaNum)         attempts.push({ label: `numero_documento(num)=~${guiaNum}`, where: `CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER)`, params: [guiaNum] });

    for (const a of attempts) {
      const r = await tryUpdateByWhere(a.label, a.where, a.params, dataPagamento);
      if (r.updated) return true;
      if (r.alreadyPaid) { console.log(`[INFO] encontrada por ${a.label}, mas já estava 'Pago'.`); return true; }
    }
  }

  if (!(valorPago > 0)) return false;

  // ---------- A) Permissionário (CNPJ exato/raiz) ----------
  let permIds = [];
  if (docPagador && isCNPJ(docPagador)) {
    const permExato = await dbGet(
      `SELECT id FROM permissionarios WHERE ${SQL_NORM('cnpj')} = ? LIMIT 1`,
      [docPagador]
    );
    if (permExato?.id) permIds = [permExato.id];

    if (permIds.length === 0) {
      const raiz = cnpjRoot(docPagador);
      const permRaizRows = await dbAll(
        `SELECT id FROM permissionarios WHERE substr(${SQL_NORM('cnpj')},1,8) = ?`,
        [raiz]
      );
      if (permRaizRows.length === 1) permIds = [permRaizRows[0].id];
      else if (permRaizRows.length > 1) permIds = permRaizRows.map(r => r.id);
    }
  }

  const attachPagoCents = (rows) => { rows._pagoCents = pagoCents; return rows; };

  if (permIds.length > 0) {
    const placeholders = permIds.map(() => '?').join(',');
    const candPerm = attachPagoCents(await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
        WHERE d.permissionario_id IN (${placeholders})
          AND d.status != 'Pago'
        ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
        LIMIT 50`,
      [...permIds, pagoCents]
    ));
    const r = await rankAndTry(candPerm, tolList, 'perm', dataPagamento);
    if (r.done || r.multi) return !!r.done;
  }

  // ---------- B) Eventos/Clientes (doc exato/raiz) ----------
  if (docPagador) {
    const candEv = attachPagoCents(await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
         JOIN DARs_Eventos de   ON de.id_dar   = d.id
         JOIN Eventos e         ON e.id        = de.id_evento
         JOIN Clientes_Eventos ce ON ce.id     = e.id_cliente
        WHERE (
              ${SQL_NORM('ce.documento')} = ?
          OR  (length(${SQL_NORM('ce.documento')})=14 AND substr(${SQL_NORM('ce.documento')},1,8) = ?)
        )
          AND d.status != 'Pago'
        ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
        LIMIT 50`,
      [docPagador, isCNPJ(docPagador) ? cnpjRoot(docPagador) : '__NO_ROOT__', pagoCents]
    ));
    const r = await rankAndTry(candEv, tolList, 'evento', dataPagamento);
    if (r.done || r.multi) return !!r.done;
  }

  // ---------- C) numeroGuia normalizado + valor ----------
  if (guiaNum) {
    const candGuia = attachPagoCents(await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
        WHERE CAST(${SQL_NORM('d.numero_documento')} AS INTEGER) = CAST(? AS INTEGER)
          AND d.status != 'Pago'
        LIMIT 20`,
      [guiaNum]
    ));
    const r = await rankAndTry(candGuia, tolList, 'guia+valor', dataPagamento);
    if (r.done || r.multi) return !!r.done;

    const ja = await dbGet(
      `SELECT id FROM dars 
        WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) 
          AND status='Pago' LIMIT 1`,
      [guiaNum]
    );
    if (ja?.id) { console.log(`[INFO] guia=${guiaNum} já estava 'Pago'.`); return true; }
  }

  // ---------- D) NOVO: guia presente dentro de barras/linha + valor ----------
  if (guiaNum) {
    const likeStr = `%${guiaNum}%`;
    const candLike = attachPagoCents(await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
        WHERE ( ${SQL_NORM('d.codigo_barras')} LIKE ${SQL_NORM("'%"+guiaNum+"%'")} 
             OR ${SQL_NORM('d.linha_digitavel')} LIKE ${SQL_NORM("'%"+guiaNum+"%'")} )
          AND d.status != 'Pago'
        LIMIT 50`.replace(/"%\+guiaNum\+%"/g, ''),
      [] // (usamos interpolação acima para manter o NORM em ambos lados; sqlite não aceita param em função)
    ).catch(async () => {
      // fallback seguro via parâmetros sem NORM no RHS
      return await dbAll(
        `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
           FROM dars d
          WHERE ( ${SQL_NORM('d.codigo_barras')} LIKE ?
               OR ${SQL_NORM('d.linha_digitavel')} LIKE ? )
            AND d.status != 'Pago'
          LIMIT 50`,
        [likeStr, likeStr]
      );
    }));
    const r = await rankAndTry(candLike, tolList, 'likeGuia+valor', dataPagamento);
    if (r.done || r.multi) return !!r.done;
  }

  // ---------- E) NOVO: janela de vencimento ±60 dias + valor ----------
  if (dataPagamento) {
    const base = String(dataPagamento).slice(0,10);
    const ini = addDays(base, -60);
    const fim = addDays(base, +60);
    const candJan = attachPagoCents(await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
        WHERE d.status != 'Pago'
          AND ABS(ROUND(d.valor*100) - ?) <= ?
          AND date(d.data_vencimento) BETWEEN date(?) AND date(?)
        ORDER BY ABS(julianday(date(d.data_vencimento)) - julianday(date(?))) ASC,
                 ABS(ROUND(d.valor*100) - ?) ASC
        LIMIT 10`,
      [pagoCents, Math.max(TOL_BASE, Math.round(pagoCents * 0.03)), ini, fim, base, pagoCents]
    ));
    dlog(`janela±60d: candidatos = ${candJan.length}`);
    if (candJan.length === 1) {
      const r = await dbRun(
        `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
        [dataPagamento || null, candJan[0].id]
      );
      if (r?.changes > 0) return true;
    } else if (candJan.length > 1) {
      const picked = await applyTiebreakers(candJan, guiaNum, dataPagamento);
      if (picked) {
        const r = await dbRun(
          `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
          [dataPagamento || null, picked.id]
        );
        if (r?.changes > 0) return true;
      }
    }

    if (guiaNum) {
  const existe = await dbGet(
    `SELECT 1 AS ok FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) LIMIT 1`,
    [guiaNum]
  );
  if (!existe?.ok) {
    console.warn(`[MOTIVO] DAR inexistente no banco para guia=${guiaNum}. Verifique se foi emitida/importada.`);
  }
}
  // Falhou todos os critérios seguros
  return false;
}


// ==========================
// Execução do mês corrente
// ==========================
async function conciliarPagamentosDoMes() {
  console.log(`[CONCILIA] Iniciando conciliação do Mês Atual... DB=${DB_PATH}`);

  const hoje = new Date();
  const primeiroDiaDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  let totalAtualizados = 0;
  const pagamentosMap = new Map();

  for (let diaCorrente = new Date(primeiroDiaDoMes); diaCorrente <= hoje; diaCorrente.setDate(diaCorrente.getDate() + 1)) {
    const dataDia = ymd(diaCorrente);
    const dtHoraInicioDia = toDateTimeString(diaCorrente, 0, 0, 0);
    const dtHoraFimDia = toDateTimeString(diaCorrente, 23, 59, 59);

    console.log(`\n[CONCILIA] Processando dia ${dataDia}...`);
    try {
      const pagsArrecadacao = await listarPagamentosPorDataArrecadacao(dataDia, dataDia);
      for (const p of pagsArrecadacao) {
        const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel || `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) {
      console.warn(`[CONCILIA] Aviso por-data-arrecadacao: ${e.message || e}`);
    }

    try {
      const pagsInclusao = await listarPagamentosPorDataInclusao(dtHoraInicioDia, dtHoraFimDia);
      for (const p of pagsInclusao) {
        const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel || `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) {
      console.warn(`[CONCILIA] Aviso por-data-inclusao: ${e.message || e}`);
    }
  }

  const todosPagamentos = Array.from(pagamentosMap.values());
  const totalEncontrados = todosPagamentos.length;
  console.log(`\n[CONCILIA] Total de ${totalEncontrados} pagamentos únicos encontrados na SEFAZ para o mês inteiro.`);

  for (const pagamento of todosPagamentos) {
    const vinculado = await tentarVincularPagamento(pagamento);
    if (vinculado) {
      console.log(`--> SUCESSO: Pagamento de ${pagamento.numeroInscricao} (Guia: ${pagamento.numeroGuia || '—'}) atualizado para 'Pago'.`);
      totalAtualizados++;
    } else {
      console.warn(`--> ALERTA: Pagamento não vinculado. DADOS SEFAZ -> CNPJ/CPF: ${pagamento.numeroInscricao}, Guia: ${pagamento.numeroGuia || '—'}, Valor: ${pagamento.valorPago}`);
    }
  }

  console.log(`\n[CONCILIA] Finalizado. Total de pagamentos da SEFAZ no período: ${totalEncontrados}. DARs atualizadas no banco: ${totalAtualizados}.`);
}

// ==========================
// Agendamento
// ==========================
function scheduleConciliacao() {
  cron.schedule('5 2 * * *', conciliarPagamentosDoMes, {
    scheduled: true,
    timezone: 'America/Maceio',
  });
  console.log('[CONCILIA] Agendador diário iniciado (02:05 America/Maceio).');
}

// Execução direta
if (require.main === module) {
  conciliarPagamentosDoMes()
    .catch((e) => {
      console.error('[CONCILIA] ERRO FATAL NA EXECUÇÃO:', e.message || e);
      process.exit(1);
    })
    .finally(() => {
      db.close((err) => {
        if (err) console.error('[CONCILIA] Erro ao fechar DB:', err.message);
      });
    });
} else {
  module.exports = { scheduleConciliacao, conciliarPagamentosDoMes };
}
