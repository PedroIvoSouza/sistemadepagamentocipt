// Em: cron/conciliarPagamentosmes.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { CONCILIACAO_TOLERANCIA_CENTAVOS = '2', DEBUG_CONCILIACAO = 'false' } = process.env;
const TOL_CENTS_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 2;
const IS_DEBUG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ==========================
// ENV e Config
// ==========================
const {
  DB_PATH = '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db', // Recomendado mover para .env
  RECEITA_CODIGO_PERMISSIONARIO,
  RECEITA_CODIGO_EVENTO,
} = process.env;

if (!DB_PATH) {
  throw new Error('Caminho do banco de dados não definido. Configure DB_PATH no seu arquivo .env');
}

// ==========================
// Helpers
// ==========================
function normalizeDoc(s = '') { return String(s).replace(/\D/g, ''); }
function cents(n) { return Math.round(Number(n || 0) * 100); }

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
    numeroInscricao: docPagadorRaw = '',
  } = pagamento;

  const docPagador = normalizeDoc(docPagadorRaw);
  const guia = String(numeroGuia || '').trim();
  const barras = String(codigoBarras || '').trim();
  const linha = String(linhaDigitavel || '').trim();

  // 0) Tentativas com chaves diretas, usando TRIM no SQL
  const diretas = [
    { nome: 'id', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id = ? AND status != 'Pago'`, val: numeroDocOrigem },
    { nome: 'codigo_barras', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE TRIM(codigo_barras) = TRIM(?) AND status != 'Pago'`, val: barras },
    { nome: 'linha_digitavel', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE TRIM(linha_digitavel) = TRIM(?) AND status != 'Pago'`, val: linha },
    { nome: 'numero_documento', sql: `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE TRIM(numero_documento) = TRIM(?) AND status != 'Pago'`, val: guia },
  ];

  for (const t of diretas) {
    if (t.val) {
      const r = await dbRun(t.sql, [dataPagamento || null, t.val]);
      if (IS_DEBUG) console.log(`[DEBUG] Tentativa direta por ${t.nome}=${t.val} → changes=${r?.changes || 0}`);
      if (r?.changes > 0) return true;
    }
  }

  // 1) Fallback por documento (permissionário) + valor com tolerância
  //    - remove a dependência de d.tipo_permissionario = 'Permissionario'
  //    - tenta com tolerância pequena; se não achar, amplia com segurança
  if (docPagador && valorPago > 0) {
    const valorCents = cents(valorPago);

    // Monta expressão "normalize(doc)" dentro do SQL
    const NORM = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${col},''),'.',''),'-',''),'/',''),' ','')`;

    // Consulta candidatos (JOIN sem amarrar ao tipo_permissionario)
    async function buscarCandidato(tolCents) {
      const rows = await dbAll(
        `SELECT d.id, d.status, d.valor, d.data_vencimento
           FROM dars d
           LEFT JOIN permissionarios p ON p.id = d.permissionario_id
          WHERE d.status != 'Pago'
            AND (${NORM('p.cnpj')} = ?)
            AND ABS(ROUND(d.valor*100) - ?) <= ?
          ORDER BY ABS(ROUND(d.valor*100) - ?) ASC, d.data_vencimento ASC
          LIMIT 2`,
        [docPagador, valorCents, tolCents, valorCents]
      );
      return rows;
    }

    // Passo A: tolerância base (2 cent por padrão)
    let rows = await buscarCandidato(TOL_CENTS_BASE);
    if (IS_DEBUG) console.log(`[DEBUG] Fallback doc+valor tol=${TOL_CENTS_BASE}¢ → ${rows.length} candidato(s)`);

    // Passo B: se não achou, tenta tolerância “média” (R$ 5,00) p/ cobrir juros/descontos comuns
    if (rows.length === 0) {
      rows = await buscarCandidato(500);
      if (IS_DEBUG) console.log('[DEBUG] Fallback doc+valor tol=500¢ →', rows.length, 'candidato(s)');
    }

    // Passo C (opcional): se ainda não achou, tolerância proporcional (até 3% ou R$ 20, o que for menor)
    if (rows.length === 0) {
      const tolPerc = Math.min(Math.round(valorCents * 0.03), 2000); // máx R$ 20,00
      rows = await buscarCandidato(tolPerc);
      if (IS_DEBUG) console.log(`[DEBUG] Fallback doc+valor tol=${tolPerc}¢ (≈3%) → ${rows.length} candidato(s)`);
    }

    if (rows.length === 1) {
      const r = await dbRun(
        `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=?`,
        [dataPagamento || null, rows[0].id]
      );
      if (r?.changes > 0) return true;
    } else if (rows.length > 1 && IS_DEBUG) {
      console.warn('[DEBUG] Ambíguo: mais de uma DAR compatível para o mesmo CNPJ + valor. Não vou conciliar automaticamente.');
    }
  }

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
