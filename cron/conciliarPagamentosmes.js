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
    // NOTA: seria muito mais rápido ter documento (CNPJ/CPF) normalizado e indexado em dars.
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
