// Em: cron/conciliarPagamentos.js
require('dotenv').config();
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const { consultarGuia, consultarPagamentosPorPeriodo } = require('../src/services/sefazService');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
  });
}

function ymdLocal(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}
function ontemLocalISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return ymdLocal(d);
}

async function conciliarD1() {
  console.log(`[CONCILIA] Iniciando conciliação D-1… DB=${DB_PATH}`);
  const inicio = ontemLocalISO();
  const fim = inicio;

  const receitas = []
    .concat(process.env.RECEITA_CODIGO_PERMISSIONARIO || [])
    .concat(process.env.RECEITA_CODIGO_EVENTO || [])
    .filter(Boolean)
    .map(Number);

  // Plano A: consultar por período (mais eficiente)
  try {
    let encontrados = 0;
    for (const receita of receitas) {
      console.log(`[CONCILIA] Consultando SEFAZ por período: ${inicio} a ${fim} (receita ${receita})`);
      const lista = await consultarPagamentosPorPeriodo({
        inicioISO: inicio, fimISO: fim, receitaCodigo: receita
      });

      if (!Array.isArray(lista) || lista.length === 0) {
        console.log(`[CONCILIA] Nenhuma guia retornada para a receita ${receita}.`);
        continue;
      }

      // Normalizar os campos que precisamos
      const pagos = lista
        .map(x => ({
          numeroGuia: x.numeroGuia || x.numero || x.guia || null,
          dataPagamento: x.dataPagamento || x.dataArrecadacao || null
        }))
        .filter(x => x.numeroGuia && x.dataPagamento);

      console.log(`[CONCILIA] Recebidas ${lista.length}; com pagamento ${pagos.length}.`);

      for (const it of pagos) {
        const dataPag = String(it.dataPagamento).slice(0, 10); // YYYY-MM-DD
        await dbRun(
          `UPDATE dars
             SET status = 'Pago',
                 data_pagamento = ?
           WHERE numero_documento = ?`,
          [dataPag, String(it.numeroGuia)]
        );
        encontrados++;
      }
    }
    console.log(`[CONCILIA] Plano A concluído. Atualizadas ${encontrados} guias.`);
    if (encontrados > 0) return; // sucesso — nem precisa do Plano B
  } catch (err) {
    console.warn('[CONCILIA] Falha no Plano A (período):', err.message);
  }

  // Plano B: consulta individual (fallback)
  try {
    console.log('[CONCILIA] Iniciando fallback: consulta individual de guias emitidas…');
    const candidatos = await dbAll(
      `SELECT id, numero_documento
         FROM dars
        WHERE numero_documento IS NOT NULL
          AND status IN ('Emitido','Pendente','Vencido')`
    );

    let atualizados = 0;
    for (const row of candidatos) {
      try {
        const det = await consultarGuia(row.numero_documento);
        const dataPag = det?.dataPagamento;
        if (dataPag) {
          await dbRun(
            `UPDATE dars
               SET status = 'Pago',
                   data_pagamento = ?
             WHERE id = ?`,
            [String(dataPag).slice(0, 10), row.id]
          );
          atualizados++;
        }
      } catch (e) {
        // Não quebra o loop por erro em um item
        console.warn(`[CONCILIA] Falha ao consultar guia ${row.numero_documento}:`, e.message);
      }
    }
    console.log(`[CONCILIA] Fallback concluído. Atualizadas ${atualizados} guias.`);
  } catch (err) {
    console.error('[CONCILIA] Falha no fallback:', err.message);
  }
}

cron.schedule('0 2 * * *', conciliarD1, { timezone: 'America/Maceio' });
console.log('[CONCILIA] Agendador diário iniciado (02:00 America/Maceio).');

// Para rodar manualmente:
// conciliarD1().then(()=>process.exit(0)).catch(()=>process.exit(1));