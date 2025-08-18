// Em: cron/conciliarPagamentos.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ======= DB =======
const DB_PATH = process.env.SQLITE_STORAGE || './sistemacipt.db';
const db = new sqlite3.Database(DB_PATH);

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

// ======= Datas D-1 =======
function ymd(d) {
  const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 10);
}
function toDateTimeISO(date, hh, mm, ss) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, ss);
  const off = new Date(local.getTime() - local.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
}

// ======= Receitas para conciliar =======
function receitasAtivas() {
  const set = new Set();
  const r1 = Number(process.env.RECEITA_CODIGO_PERMISSIONARIO || 0);
  const r2 = Number(process.env.RECEITA_CODIGO_EVENTO || 0);
  if (r1 > 0) set.add(r1);
  if (r2 > 0) set.add(r2);
  return Array.from(set);
}

// ======= Conciliação =======
async function conciliarPagamentosD1() {
  console.log(`[CONCILIA] Iniciando conciliação D-1... DB=${DB_PATH}`);

  // janela D-1
  const hoje = new Date();
  const d1 = new Date(hoje);
  d1.setDate(d1.getDate() - 1);

  const dataIni = ymd(d1); // 'YYYY-MM-DD'
  const dataFim = ymd(d1);

  const dtIni = toDateTimeISO(d1, 0, 0, 0);   // 'YYYY-MM-DDTHH:mm:ss'
  const dtFim = toDateTimeISO(d1, 23, 59, 59);

  const receitas = receitasAtivas();
  if (receitas.length === 0) {
    console.warn('[CONCILIA] Nenhuma receita configurada no .env (RECEITA_CODIGO_PERMISSIONARIO/RECEITA_CODIGO_EVENTO).');
    return;
  }

  let totalEncontrados = 0;
  let totalAtualizados = 0;

  for (const cod of receitas) {
    console.log(`[CONCILIA] Buscando pagamentos de ${dataIni} a ${dataFim} para receita ${cod}...`);

    let itens = [];
    try {
      itens = await listarPagamentosPorDataArrecadacao(dataIni, dataFim, cod);
    } catch (e) {
      console.warn(`[CONCILIA] Falha no por-data-arrecadacao: ${e.message || e}`);
    }

    if (!Array.isArray(itens) || itens.length === 0) {
      try {
        itens = await listarPagamentosPorDataInclusao(dtIni, dtFim, cod);
      } catch (e) {
        console.warn(`[CONCILIA] Falha no por-data-inclusao: ${e.message || e}`);
      }
    }

    console.log(`[CONCILIA] Receita ${cod}: retornados ${itens.length} registros.`);

    for (const it of itens) {
      const numero = String(it.numeroGuia || '').trim();
      if (!numero) continue;

      totalEncontrados += 1;

      // 1) Tenta por numero_documento (caminho oficial)
      const r1 = await dbRun(
        `UPDATE dars
            SET status = 'Pago',
                data_pagamento = COALESCE(?, data_pagamento)
          WHERE numero_documento = ?`,
        [it.dataPagamento || null, numero]
      );
      if (r1?.changes > 0) {
        totalAtualizados += r1.changes;
        continue;
      }

      // 2) Fallback: legado sem numero_documento -> usa codigo_barras
      const r2 = await dbRun(
        `UPDATE dars
            SET status = 'Pago',
                data_pagamento = COALESCE(?, data_pagamento),
                numero_documento = COALESCE(numero_documento, codigo_barras)
          WHERE codigo_barras = ?
            AND (numero_documento IS NULL OR numero_documento = '')`,
        [it.dataPagamento || null, numero]
      );
      if (r2?.changes > 0) {
        totalAtualizados += r2.changes;
        continue;
      }

      // 3) Em alguns retornos o campo que “bate” é a linha digitável.
      const r3 = await dbRun(
        `UPDATE dars
            SET status = 'Pago',
                data_pagamento = COALESCE(?, data_pagamento)
          WHERE linha_digitavel = ?`,
        [it.dataPagamento || null, numero]
      );
      if (r3?.changes > 0) {
        totalAtualizados += r3.changes;
      }
    }
  }

  console.log(`[CONCILIA] Finalizado. Registros retornados: ${totalEncontrados}. DARs atualizados: ${totalAtualizados}.`);
}

// ======= Agendamento diário (02:05 America/Maceio) =======
function scheduleConciliacao() {
  cron.schedule('5 2 * * *', conciliarPagamentosD1, {
    scheduled: true,
    timezone: 'America/Maceio',
  });
  console.log('[CONCILIA] Agendador diário iniciado (02:05 America/Maceio).');
}

// Se rodar diretamente: executa uma vez
if (require.main === module) {
  conciliarPagamentosD1()
    .catch((e) => {
      console.error('[CONCILIA] ERRO:', e.message || e);
      process.exit(1);
    })
    .finally(() => db.close());
} else {
  // exporta para ser usado pelo seu index/boot
  module.exports = { scheduleConciliacao, conciliarPagamentosD1 };
}
