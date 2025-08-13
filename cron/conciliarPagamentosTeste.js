// Em: cron/conciliarPagamentos.js (versão teste)
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();

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

function ymd(d) {
  const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 10);
}
function toDateTimeISO(date, hh, mm, ss) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, ss);
  const off = new Date(local.getTime() - local.getTimezoneOffset() * 60000);
  return off.toISOString().slice(0, 19);
}

function receitasAtivas() {
  const set = new Set();
  const r1 = Number(process.env.RECEITA_CODIGO_PERMISSIONARIO || 0);
  const r2 = Number(process.env.RECEITA_CODIGO_EVENTO || 0);
  if (r1 > 0) set.add(r1);
  if (r2 > 0) set.add(r2);
  return Array.from(set);
}

async function conciliarPagamentosTeste() {
  console.log(`[TESTE] Iniciando conciliação... DB=${DB_PATH}`);

  // ======= DATA FIXA PARA TESTE =======
  const d1 = new Date('2025-08-01'); // <- coloque aqui uma data que você sabe que teve pagamento
  const dataIni = ymd(d1);
  const dataFim = ymd(d1);
  const dtIni = toDateTimeISO(d1, 0, 0, 0);
  const dtFim = toDateTimeISO(d1, 23, 59, 59);

  const receitas = receitasAtivas();
  if (receitas.length === 0) {
    console.warn('[TESTE] Nenhuma receita configurada no .env');
    return;
  }

  let totalEncontrados = 0;
  let totalAtualizados = 0;

  for (const cod of receitas) {
    console.log(`[TESTE] Buscando pagamentos de ${dataIni} a ${dataFim} para receita ${cod}...`);

    let itens = [];
    try {
      itens = await listarPagamentosPorDataArrecadacao(dataIni, dataFim, cod);
    } catch (e) {
      console.warn(`[TESTE] Falha no por-data-arrecadacao: ${e.message || e}`);
    }

    if (!Array.isArray(itens) || itens.length === 0) {
      try {
        itens = await listarPagamentosPorDataInclusao(dtIni, dtFim, cod);
      } catch (e) {
        console.warn(`[TESTE] Falha no por-data-inclusao: ${e.message || e}`);
      }
    }

    // 📌 Mostra o JSON bruto
    console.log(`[TESTE] JSON bruto retornado para receita ${cod}:`);
    console.dir(itens, { depth: null });

    console.log(`[TESTE] Receita ${cod}: retornados ${itens.length} registros.`);

    for (const it of itens) {
      const numero = String(it.numeroGuia || '').trim();
      if (!numero) continue;
      totalEncontrados += 1;

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

  console.log(`[TESTE] Finalizado. Registros retornados: ${totalEncontrados}. DARs atualizados: ${totalAtualizados}.`);
}

if (require.main === module) {
  conciliarPagamentosTeste()
    .catch((e) => {
      console.error('[TESTE] ERRO:', e.message || e);
      process.exit(1);
    })
    .finally(() => db.close());
}