// Em: cron/conciliarPagamentosmes.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const {
  DB_PATH = '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db',
  RECEITA_CODIGO_PERMISSIONARIO,
  RECEITA_CODIGO_EVENTO,
  CONCILIACAO_TOLERANCIA_CENTAVOS = '500', // 5 reais
  DEBUG_CONCILIACAO = 'true',
} = process.env;

const TOL_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 500;
const DBG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const dlog = (...a) => { if (DBG) console.log('[DEBUG]', ...a); };

console.log(`BUILD: conciliarPagamentosmes.js @ ${new Date().toISOString()} | TOL_BASE=${TOL_BASE}¢ | DEBUG=${DBG}`);

// (opcional) echo de algumas envs úteis de backend SEFAZ
try {
  const { SEFAZ_MODE, SEFAZ_TLS_INSECURE, SEFAZ_APP_TOKEN } = process.env;
  console.log('\n--- VERIFICANDO VARIÁVEIS DE AMBIENTE CARREGADAS ---');
  if (SEFAZ_MODE) console.log(`SEFAZ_MODE: [${SEFAZ_MODE}]`);
  if (SEFAZ_TLS_INSECURE) console.log(`SEFAZ_TLS_INSECURE: [${SEFAZ_TLS_INSECURE}]`);
  if (SEFAZ_APP_TOKEN) console.log(`SEFAZ_APP_TOKEN (primeiros 5 caracteres): [${String(SEFAZ_APP_TOKEN).slice(0,5)}...]`);
  console.log('----------------------------------------------------\n');
} catch (_) {}

// ==========================
// SEFAZ service
// ==========================
const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ==========================
// Helpers
// ==========================
function normalizeDoc(s = '') { return String(s).replace(/\D/g, ''); }
function cents(n) { return Math.round(Number(n || 0) * 100); }
function isCNPJ(s = '') { return /^\d{14}$/.test(normalizeDoc(s)); }
function cnpjRoot(s = '') { return normalizeDoc(s).slice(0, 8); } // 8 dígitos iniciais
function SQL_NORM(col) {
  // Normaliza no SQLite (remove . - / e espaços)
  return `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`;
}
function endsWithSufixoGuia(numDoc, guiaNum, minLen = 6) {
  const a = normalizeDoc(numDoc || '');
  const b = normalizeDoc(guiaNum || '');
  if (!a || !b) return false;
  const sfx = b.slice(-Math.min(minLen, b.length));
  return a.endsWith(sfx);
}

async function applyTiebreakers(cands, guiaNum, dtPgto) {
  let list = (cands || []).slice();

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

    const best = list[0];
    const second = list[1];
    if (!second) return best;

    const baseTs = base.getTime();
    const diff1 = Math.abs(new Date(best.data_vencimento || '1970-01-01') - baseTs);
    const diff2 = Math.abs(new Date(second.data_vencimento || '1970-01-01') - baseTs);
    if (diff1 < diff2) return best;
  }

  return null; // segue ambíguo
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
// Datas
// ==========================
function ymd(d) {
  // Retorna YYYY-MM-DD no “local day”
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
  return `${yyyy}-${MM}-${dd} ${HH}:${mm_}:${ss_}`; // Ex: 2025-08-01 00:00:00
}

// ==========================
// (Opcional) Receitas para conciliar — não usadas enquanto “puxamos tudo”.
// ==========================
function receitasAtivas() {
  const set = new Set();
  [RECEITA_CODIGO_PERMISSIONARIO, RECEITA_CODIGO_EVENTO].forEach(envVar => {
    if (envVar) {
      const cod = Number(normalizeDoc(envVar));
      if (cod) set.add(cod);
      else throw new Error(`Código de receita inválido encontrado no .env: ${envVar}`);
    }
  });
  return Array.from(set);
}

// ==========================
// Rank helper (com tie-breakers)
// ==========================
async function rankAndTry(rows, tolList, ctxLabel, dtPgto, guiaNum, pagoCents) {
  rows = rows || [];
  dlog(`${ctxLabel}: candidatos pré-tolerância = ${rows.length}`);

  for (const tol of tolList) {
    const candTol = rows.filter(r => Math.abs(Math.round(r.valor * 100) - pagoCents) <= tol);
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

// ==========================
// Conciliação
// ==========================
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
  const tolList = [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents * 0.03))];

  // ---------- 0) Tentativas diretas ----------
  // 0.1) chaves diretas simples
  const diretas = [
    { label: 'id', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`, val: numeroDocOrigem },
    { label: 'codigo_barras', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE codigo_barras=? AND status!='Pago'`, val: codigoBarras },
    { label: 'linha_digitavel', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE linha_digitavel=? AND status!='Pago'`, val: linhaDigitavel },
    { label: 'numero_documento', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE numero_documento=? AND status!='Pago'`, val: guiaNum },
  ];

  for (const t of diretas) {
    if (!t.val) continue;
    const r = await dbRun(t.sql, [dataPagamento || null, t.val]);
    dlog(`direta: ${t.label}=${t.val} → changes=${r?.changes || 0}`);
    if (r?.changes > 0) return true;

    // se já estava pago, considera sucesso e loga
    let wherePaid = '';
    if (t.label === 'numero_documento') {
      wherePaid = `CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER)`;
    } else if (t.label === 'codigo_barras' || t.label === 'linha_digitavel') {
      wherePaid = `${t.label} = ?`;
    } else if (t.label === 'id') {
      wherePaid = `id = ?`;
    }
    if (wherePaid) {
      const already = await dbGet(`SELECT id FROM dars WHERE ${wherePaid} AND status='Pago' LIMIT 1`, [t.val]);
      if (already?.id) {
        console.log(`[INFO] encontrada por ${t.label}=${t.val}, mas já estava 'Pago'.`);
        return true;
      }
    }
  }

  // 0.2) equivalências normalizadas (sem pontuação)
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
    if (already?.id) {
      console.log(`[INFO] encontrada por codigo_barras=${codigoBarras}, mas já estava 'Pago'.`);
      return true;
    }
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
    if (already?.id) {
      console.log(`[INFO] encontrada por numero_documento=${guiaNum}, mas já estava 'Pago'.`);
      return true;
    }
  }

  // Se não tem valor, não dá pra seguir nos fallbacks por proximidade de valor
  if (!(valorPago > 0)) return false;

  // ---------- 1) Permissionário: exato -> raiz ----------
  let permIds = [];
  if (isCNPJ(docPagador)) {
    // exato
    const permExato = await dbGet(
      `SELECT id FROM permissionarios WHERE ${SQL_NORM('cnpj')} = ? LIMIT 1`,
      [docPagador]
    );
    if (permExato?.id) permIds = [permExato.id];

    // raiz, se não encontrou exato
    if (permIds.length === 0) {
      const raiz = cnpjRoot(docPagador);
      const permRaiz = await dbAll(
        `SELECT id FROM permissionarios WHERE substr(${SQL_NORM('cnpj')},1,8) = ?`,
        [raiz]
      );
      if (permRaiz.length === 1) {
        permIds = [permRaiz[0].id];
      } else if (permRaiz.length > 1) {
        permIds = permRaiz.map(r => r.id);
      }
    }
  }

  if (permIds.length > 0) {
    const placeholders = permIds.map(() => '?').join(',');
    const candPerm = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
        WHERE d.permissionario_id IN (${placeholders})
          AND d.status != 'Pago'
        ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
        LIMIT 50`,
      [...permIds, pagoCents]
    );
    const r = await rankAndTry(candPerm, tolList, 'perm', dataPagamento, guiaNum, pagoCents);
    if (r.done || r.multi) return !!r.done;
  }

  // ---------- 2) Eventos / Clientes_Eventos (exato doc ou raiz) ----------
  const candEv = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
       FROM dars d
       JOIN DARs_Eventos de ON de.id_dar = d.id
       JOIN Eventos e       ON e.id = de.id_evento
       JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
      WHERE (
            ${SQL_NORM('ce.documento')} = ?
        OR  (length(${SQL_NORM('ce.documento')})=14 AND substr(${SQL_NORM('ce.documento')},1,8) = ?)
      )
        AND d.status != 'Pago'
      ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
      LIMIT 50`,
    [docPagador, isCNPJ(docPagador) ? cnpjRoot(docPagador) : '__NO_ROOT__', pagoCents]
  );
  {
    const r = await rankAndTry(candEv, tolList, 'evento', dataPagamento, guiaNum, pagoCents);
    if (r.done || r.multi) return !!r.done;
  }

  // ---------- 3) Guia + valor ----------
  if (guiaNum) {
    const candGuia = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
        WHERE CAST(${SQL_NORM('d.numero_documento')} AS INTEGER) = CAST(? AS INTEGER)
          AND d.status != 'Pago'
        ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
        LIMIT 50`,
      [guiaNum, pagoCents]
    );
    const r = await rankAndTry(candGuia, tolList, 'guia+valor', dataPagamento, guiaNum, pagoCents);
    if (r.done || r.multi) return !!r.done;
  }

  // ---------- 4) LIKE sufixo da guia + valor (ex.: últimos 6 dígitos) ----------
  if (guiaNum) {
    const sfx = normalizeDoc(guiaNum).slice(-6);
    if (sfx) {
      const candLike = await dbAll(
        `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
           FROM dars d
          WHERE ${SQL_NORM('d.numero_documento')} LIKE '%' || ?
            AND d.status != 'Pago'
          ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
          LIMIT 50`,
        [sfx, pagoCents]
      );
      const r = await rankAndTry(candLike, tolList, 'likeGuia+valor', dataPagamento, guiaNum, pagoCents);
      if (r.done || r.multi) return !!r.done;
    }
  }

  // ---------- 5) Janela de vencimento ±60 dias + valor ----------
  // (último recurso conservador)
  const baseDt = dataPagamento ? String(dataPagamento).slice(0, 10) : ymd(new Date());
  const maxTol = Math.max(TOL_BASE, Math.round(pagoCents * 0.03));
  const candJan = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
       FROM dars d
      WHERE d.status != 'Pago'
        AND ABS(ROUND(d.valor*100) - ?) <= ?
        AND ABS(julianday(d.data_vencimento) - julianday(?)) <= 60
      ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
      LIMIT 50`,
    [pagoCents, maxTol, baseDt, pagoCents]
  );
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

  // ---------- Diagnóstico: DAR inexistente por guia ----------
  if (guiaNum) {
    const existe = await dbGet(
      `SELECT 1 AS ok FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) LIMIT 1`,
      [guiaNum]
    );
    if (!existe?.ok) {
      console.warn(`[MOTIVO] DAR inexistente no banco para guia=${guiaNum}. Verifique se foi emitida/importada.`);
    }
  }

  return false;
}

async function conciliarPagamentosDoMes() {
  console.log(`[CONCILIA] Iniciando conciliação do Mês Atual... DB=${DB_PATH}`);

  const hoje = new Date();
  const primeiroDiaDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  let totalAtualizados = 0;
  const pagamentosMap = new Map();

  // LOOP DIA A DIA
  for (let diaCorrente = new Date(primeiroDiaDoMes); diaCorrente <= hoje; diaCorrente.setDate(diaCorrente.getDate() + 1)) {
    const dataDia = ymd(diaCorrente);
    const dtHoraInicioDia = toDateTimeString(diaCorrente, 0, 0, 0);
    const dtHoraFimDia = toDateTimeString(diaCorrente, 23, 59, 59);

    console.log(`\n[CONCILIA] Processando dia ${dataDia}...`);

    // 1) Arrecadação do dia (sem codigoReceita)
    try {
      const pagsArrecadacao = await listarPagamentosPorDataArrecadacao(dataDia, dataDia);
      for (const p of pagsArrecadacao) {
        const key = p.numeroGuia || p.codigoBarras || p.linhaDigitavel || `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) {
      console.warn(`[CONCILIA] Aviso por-data-arrecadacao: ${e.message || e}`);
    }

    // 2) Inclusão do dia (sem codigoReceita)
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

  // Após percorrer todos os dias, consolidamos e conciliamos
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

// Se rodar diretamente: executa uma vez
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
  // exporta para ser usado pelo seu index/boot
  module.exports = { scheduleConciliacao, conciliarPagamentosDoMes };
}
