// Em: cron/conciliarPagamentosmes.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const IS_DEBUG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const {
  DB_PATH = '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db',
  RECEITA_CODIGO_PERMISSIONARIO,
  RECEITA_CODIGO_EVENTO,
  CONCILIACAO_TOLERANCIA_CENTAVOS = '500',  // default: 5 reais
  DEBUG_CONCILIACAO = 'true',
} = process.env;

const TOL_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 500;
const DBG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const dlog = (...a) => { if (DBG) console.log('[DEBUG]', ...a); };

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
// (Opcional) Receitas para conciliar
// Mantida caso você queira voltar a filtrar por receita no futuro.
// NÃO é usada enquanto “puxamos tudo”.
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
// Conciliação
// ==========================

/**
 * Tenta vincular um pagamento a uma DAR no banco de dados, retornando true se bem-sucedido.
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
  if (!docPagador) return false;

  // 0) Tentativas diretas (chaves únicas)
  const diretas = [
    { label: 'id', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`, val: numeroDocOrigem },
    { label: 'codigo_barras', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE codigo_barras=? AND status!='Pago'`, val: codigoBarras },
    { label: 'linha_digitavel', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE linha_digitavel=? AND status!='Pago'`, val: linhaDigitavel },
    { label: 'numero_documento', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE numero_documento=? AND status!='Pago'`, val: numeroGuia },
  ];
  for (const t of diretas) {
    if (!t.val) continue;
    const r = await dbRun(t.sql, [dataPagamento || null, t.val]);
    dlog(`Tentativa direta por ${t.label}=${t.val} → changes=${r?.changes || 0}`);
    if (r?.changes > 0) return true;
  }

  // 1) Fallbacks por doc+valor
  if (!(valorPago > 0)) return false;
  const pagoCents = cents(valorPago);

  // helper p/ normalizar colunas em SQL sem precisar de funções custom:
  const NORM = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`;

  // Estratégia A: caminho direto do permissionário (mais comum nos seus casos)
  // 1.A) pega o ID do permissionário pelo CNPJ
   // 1) Fallbacks por doc+valor
  if (!(valorPago > 0)) return false;
  const pagoCents = cents(valorPago);

  const NORM = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`;

  // ---------- Estratégia A: Permissionário (exato -> raiz -> multi) ----------
  let permIds = [];

  if (isCNPJ(docPagador)) {
    // A.1) exato
    const permExato = await dbGet(
      `SELECT id FROM permissionarios WHERE ${NORM('cnpj')} = ? LIMIT 1`,
      [docPagador]
    );
    if (permExato?.id) permIds = [permExato.id];

    // A.2) raiz (matriz/filial) se não encontrou exato
    if (permIds.length === 0) {
      const raiz = cnpjRoot(docPagador);
      const permRaiz = await new Promise((resolve, reject) => {
        db.all(
          `SELECT id FROM permissionarios 
            WHERE substr(${NORM('cnpj')},1,8) = ?`,
          [raiz],
          (err, rows) => err ? reject(err) : resolve(rows || [])
        );
      });
      if (permRaiz.length === 1) {
        permIds = [permRaiz[0].id];
      } else if (permRaiz.length > 1) {
        // vários permissionários com essa raiz — vamos considerar todos no ranking por valor
        permIds = permRaiz.map(r => r.id);
      }
    }
  }

  const rankAndTry = async (rows, tolList) => {
    for (const tol of tolList) {
      const candTol = rows.filter(r => Math.abs(Math.round(r.valor * 100) - pagoCents) <= tol);
      dlog(`Fallback doc+valor tol=${tol}¢ → ${candTol.length} candidato(s)`);
      if (candTol.length === 1) {
        const r = await dbRun(
          `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
          [dataPagamento || null, candTol[0].id]
        );
        if (r?.changes > 0) return { done: true };
      } else if (candTol.length > 1) {
        // ambíguo: não concilia automaticamente
        dlog(`Ambíguo (${candTol.length}) na tolerância. Exemplos:`,
             candTol.slice(0, 3).map(x => ({ id: x.id, valor: x.valor, numero_documento: x.numero_documento })));
        return { done: false, multi: true };
      }
    }
    return { done: false };
  };

  if (permIds.length > 0) {
    // Busca DARs de todos os permissionários candidatos, ordenando por proximidade de valor e data
    const placeholders = permIds.map(() => '?').join(',');
    const candPerm = await new Promise((resolve, reject) => {
      db.all(
        `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
           FROM dars d
          WHERE d.permissionario_id IN (${placeholders})
            AND d.status != 'Pago'
          ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
          LIMIT 20`,
        [...permIds, pagoCents],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });

    const res = await rankAndTry(candPerm, [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents * 0.03))]);
    if (res.done || res.multi) return !!res.done;
  }
  // ---------- Estratégia B: via Eventos/Clientes (exato ou raiz) ----------
  const candsEv = await new Promise((resolve, reject) => {
    db.all(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento
         FROM dars d
         JOIN DARs_Eventos de ON de.id_dar = d.id
         JOIN Eventos e       ON e.id = de.id_evento
         JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
        WHERE (
              ${NORM('ce.documento')} = ?
          OR  (length(${NORM('ce.documento')})=14 AND substr(${NORM('ce.documento')},1,8) = ?)
        )
          AND d.status != 'Pago'
        ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
        LIMIT 20`,
      [docPagador, isCNPJ(docPagador) ? cnpjRoot(docPagador) : '__NO_ROOT__', pagoCents],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });

  {
    const res = await rankAndTry(candsEv, [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents * 0.03))]);
    if (res.done || res.multi) return !!res.done;
  }

  // Nada casou
  return false;
}

async function conciliarPagamentosDoMes() {
  console.log(`[CONCILIA] Iniciando conciliação do Mês Atual... DB=${DB_PATH}`);

  // “Puxar tudo”: NÃO vamos iterar por receita.
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
        // chave de dedupe robusta
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
