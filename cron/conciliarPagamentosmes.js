// Em: cron/conciliarPagamentosmes.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

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
  const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 10);
}
function toDateTimeISO(date, hh, mm, ss) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, ss);
  const off = new Date(local.getTime() - local.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
}

// ==========================
// Receitas para conciliar
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
    numeroInscricao: docPagador = '',
  } = pagamento;

  if (!docPagador) return false;

  // Tentativas com chaves diretas (id, barras, etc.)
  const tentativasDiretas = [
    { key: 'id', value: numeroDocOrigem, query: `UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento) WHERE id = ? AND status != 'Pago'` },
    { key: 'codigo_barras', value: codigoBarras, query: `UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento) WHERE codigo_barras = ? AND status != 'Pago'` },
    { key: 'linha_digitavel', value: linhaDigitavel, query: `UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento) WHERE linha_digitavel = ? AND status != 'Pago'` },
    { key: 'numero_documento', value: numeroGuia, query: `UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento) WHERE numero_documento = ? AND status != 'Pago'` },
  ];

  for (const tentativa of tentativasDiretas) {
    if (tentativa.value) {
      const res = await dbRun(tentativa.query, [dataPagamento || null, tentativa.value]);
      if (res?.changes > 0) return true;
    }
  }

  // Tentativa 5 (robusta): Documento + Valor com tolerância
  if (valorPago > 0) {
    // NOTA DE PERFORMANCE: Esta query seria muito mais rápida se os documentos (CNPJ/CPF)
    // fossem armazenados em uma coluna normalizada (apenas dígitos) e indexada.
    const row = await dbGet(
      `SELECT d.id, d.status FROM dars d
       LEFT JOIN permissionarios p ON d.tipo_permissionario = 'Permissionario' AND d.permissionario_id = p.id
       LEFT JOIN DARs_Eventos de ON de.id_dar = d.id
       LEFT JOIN Eventos e ON e.id = de.id_evento
       LEFT JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
       WHERE (
         REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(p.cnpj,''),'.',''),'-',''),'/',''),' ','') = ? OR
         REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(ce.documento,''),'.',''),'-',''),'/',''),' ','') = ?
       )
       AND d.status != 'Pago'
       AND ABS(ROUND(d.valor*100) - ?) <= 2 -- tolera até 2 centavos
       ORDER BY d.data_vencimento ASC
       LIMIT 1`,
      [docPagador, docPagador, cents(valorPago)]
    );
    
    if (row?.id) {
      const res = await dbRun(`UPDATE dars SET status='Pago', data_pagamento=? WHERE id=?`, [dataPagamento || null, row.id]);
      if (res?.changes > 0) return true;
    }
  }
  
  return false;
}

async function conciliarPagamentosDoMes() {
  console.log(`[CONCILIA] Iniciando conciliação do Mês Atual... DB=${DB_PATH}`);

  const receitas = receitasAtivas();
  if (receitas.length === 0) {
    console.warn('[CONCILIA] Nenhuma receita configurada no .env para conciliação.');
    return;
  }

  const hoje = new Date();
  const primeiroDiaDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  // Formata as datas para o range completo do mês até hoje
  const dataInicioPeriodo = ymd(primeiroDiaDoMes);
  const dataFimPeriodo = ymd(hoje);
  const dtHoraInicioPeriodo = toDateTimeISO(primeiroDiaDoMes, 0, 0, 0);
  const dtHoraFimPeriodo = toDateTimeISO(hoje, 23, 59, 59);

  let totalEncontrados = 0;
  let totalAtualizados = 0;
  const pagamentosMap = new Map();

  for (const cod of receitas) {
    console.log(`[CONCILIA] Buscando pagamentos de ${dataInicioPeriodo} a ${dataFimPeriodo} para receita ${cod}...`);
    
    // 1. Busca por data de arrecadação
    try {
      const pagsArrecadacao = await listarPagamentosPorDataArrecadacao(dataInicioPeriodo, dataFimPeriodo, cod);
      for (const p of pagsArrecadacao) {
        if (p.numeroGuia) pagamentosMap.set(p.numeroGuia, p);
      }
    } catch (e) {
      console.error(`[CONCILIA] ERRO SEVERO ao buscar por-data-arrecadacao: ${e.message || e}`);
    }

    // 2. Busca por data de inclusão (para pegar pagamentos que entraram no sistema depois)
    try {
      const pagsInclusao = await listarPagamentosPorDataInclusao(dtHoraInicioPeriodo, dtHoraFimPeriodo, cod);
      for (const p of pagsInclusao) {
        if (p.numeroGuia && !pagamentosMap.has(p.numeroGuia)) {
            pagamentosMap.set(p.numeroGuia, p);
        }
      }
    } catch (e) {
      console.error(`[CONCILIA] ERRO SEVERO ao buscar por-data-inclusao: ${e.message || e}`);
    }
  }
  
  const todosPagamentos = Array.from(pagamentosMap.values());
  totalEncontrados = todosPagamentos.length;
  console.log(`[CONCILIA] Total de ${totalEncontrados} pagamentos únicos encontrados na SEFAZ para o período.`);

  for (const pagamento of todosPagamentos) {
    const vinculado = await tentarVincularPagamento(pagamento);

    if (vinculado) {
      console.log(`--> SUCESSO: Pagamento de ${pagamento.numeroInscricao} (Guia: ${pagamento.numeroGuia}) foi vinculado e atualizado para 'Pago'.`);
      totalAtualizados++;
    } else {
      console.warn(`--> ALERTA: Pagamento não vinculado. DADOS SEFAZ -> CNPJ/CPF: ${pagamento.numeroInscricao}, Guia: ${pagamento.numeroGuia}, Valor: ${pagamento.valorPago}`);
    }
  }

  console.log(`[CONCILIA] Finalizado. Total de pagamentos da SEFAZ no período: ${totalEncontrados}. DARs atualizadas no banco: ${totalAtualizados}.`);
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
