// Em: cron/conciliarPagamentosmes.js
console.log('[DEBUG] Ponto 1: Script iniciado.');

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

console.log('[DEBUG] Ponto 2: Módulos carregados.');

// ======= DB =======
const DB_PATH = process.env.SQLITE_STORAGE || require('path').resolve(__dirname, '../sistemacipt.db');
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

// ======= Datas =======
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
  const r1 = Number(String(process.env.RECEITA_CODIGO_PERMISSIONARIO).replace(/\D/g, ''));
  if (process.env.RECEITA_CODIGO_PERMISSIONARIO && !r1) {
    throw new Error('RECEITA_CODIGO_PERMISSIONARIO inválido.');
  }
  const r2 = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
  if (process.env.RECEITA_CODIGO_EVENTO && !r2) {
    throw new Error('RECEITA_CODIGO_EVENTO inválido.');
  }
  if (r1) set.add(r1);
  if (r2) set.add(r2);
  return Array.from(set);
}

// ======= Conciliação =======
async function conciliarPagamentosD1() {
  console.log('[DEBUG] Ponto 3: Função conciliarPagamentosD1 chamada.');

  const receitas = receitasAtivas();
  if (receitas.length === 0) {
    console.warn('[CONCILIA] Nenhuma receita configurada no .env (RECEITA_CODIGO_PERMISSIONARIO/RECEITA_CODIGO_EVENTO).');
    return;
  }

  const hoje = new Date();
  const primeiroDiaDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const ultimoDiaParaBuscar = hoje;

  let totalEncontrados = 0;
  let totalAtualizados = 0;

  console.log(`[DEBUG] Limite Inferior do Loop: ${primeiroDiaDoMes.toISOString()}`);
  console.log(`[DEBUG] Limite Superior do Loop: ${ultimoDiaParaBuscar.toISOString()}`);
  console.log('[DEBUG] Ponto 4: Prestes a iniciar o loop de dias.');

  for (let diaCorrente = new Date(primeiroDiaDoMes); diaCorrente <= ultimoDiaParaBuscar; diaCorrente.setDate(diaCorrente.getDate() + 1)) {
    console.log(`[DEBUG] Ponto 5: Processando dia ${ymd(diaCorrente)}`);
    
    const dataDia = ymd(diaCorrente);
    const dtIniDia = toDateTimeISO(diaCorrente, 0, 0, 0);
    const dtFimDia = toDateTimeISO(diaCorrente, 23, 59, 59);

    for (const cod of receitas) {
      console.log(`[CONCILIA] Buscando pagamentos de ${dataDia} para receita ${cod}...`);
      let itens = [];
      try {
        itens = await listarPagamentosPorDataArrecadacao(dataDia, dataDia, cod);
      } catch (e) {
        console.warn(`[CONCILIA] Falha no por-data-arrecadacao: ${e.message || e}`);
      }
      if (!Array.isArray(itens) || itens.length === 0) {
        try {
          itens = await listarPagamentosPorDataInclusao(dtIniDia, dtFimDia, cod);
        } catch (e) {
          console.warn(`[CONCILIA] Falha no por-data-inclusao: ${e.message || e}`);
        }
      }
      if (itens.length > 0) {
        console.log(`[CONCILIA] Receita ${cod} em ${dataDia}: retornados ${itens.length} registros.`);
      }
      for (const it of itens) {
        const numero = String(it.numeroGuia || '').trim();
        if (!numero) continue;
        totalEncontrados += 1;
        const r1 = await dbRun(`UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento) WHERE numero_documento = ?`, [it.dataPagamento || null, numero]);
        if (r1?.changes > 0) { totalAtualizados += r1.changes; continue; }
        const r2 = await dbRun(`UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento), numero_documento = COALESCE(numero_documento, codigo_barras) WHERE codigo_barras = ? AND (numero_documento IS NULL OR numero_documento = '')`, [it.dataPagamento || null, numero]);
        if (r2?.changes > 0) { totalAtualizados += r2.changes; continue; }
        const r3 = await dbRun(`UPDATE dars SET status = 'Pago', data_pagamento = COALESCE(?, data_pagamento) WHERE linha_digitavel = ?`, [it.dataPagamento || null, numero]);
        if (r3?.changes > 0) { totalAtualizados += r3.changes; }
      }
    }
  }

  console.log(`[CONCILIA] Finalizado. Registros retornados no período todo: ${totalEncontrados}. DARs atualizados: ${totalAtualizados}.`);
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
    .finally(() => {
      console.log('[DEBUG] Ponto 6: Processo finalizado, fechando DB.');
      db.close();
    });
} else {
  // exporta para ser usado pelo seu index/boot
  module.exports = { scheduleConciliacao, conciliarPagamentosD1 };
}
