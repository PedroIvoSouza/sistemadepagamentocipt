// scripts/conciliarEListarPagos.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ------- DB -------
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
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// Helpers
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

// ------- Conciliação + relatório -------
async function conciliarEListarPagos() {
  console.log(`[CONCILIA] Iniciando (DB=${DB_PATH})`);

  const hoje = new Date();
  hoje.setDate(hoje.getDate() - 1); // D-1

  const dataIni = ymd(hoje);
  const dataFim = ymd(hoje);
  const dtIni = toDateTimeISO(hoje, 0, 0, 0);
  const dtFim = toDateTimeISO(hoje, 23, 59, 59);

  const receitas = receitasAtivas();
  const pagos = [];

  for (const cod of receitas) {
    let itens = [];
    try {
      itens = await listarPagamentosPorDataArrecadacao(dataIni, dataFim, cod);
    } catch {}
    if (!Array.isArray(itens) || itens.length === 0) {
      try {
        itens = await listarPagamentosPorDataInclusao(dtIni, dtFim, cod);
      } catch {}
    }

    for (const it of itens) {
      const numero = String(it.numeroGuia || '').trim();
      if (!numero) continue;

      const r1 = await dbRun(
        `UPDATE dars
             SET status = 'Pago',
                 data_pagamento = COALESCE(?, data_pagamento)
           WHERE numero_documento = ?`,
        [it.dataPagamento || null, numero]
      );
      if (r1?.changes > 0) {
        pagos.push(numero);
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
        pagos.push(numero);
        continue;
      }
      const r3 = await dbRun(
        `UPDATE dars
             SET status = 'Pago',
                 data_pagamento = COALESCE(?, data_pagamento)
           WHERE linha_digitavel = ?`,
        [it.dataPagamento || null, numero]
      );
      if (r3?.changes > 0) pagos.push(numero);
    }
  }

  if (pagos.length === 0) {
    console.log('Nenhum pagamento encontrado.');
    return;
  }

  const relatorio = await dbAll(
    `SELECT d.id, d.numero_documento, d.data_pagamento,
            COALESCE(p.nome_empresa, ce.nome_razao_social) AS contribuinte,
            CASE WHEN ce.id IS NULL THEN 'PERMISSIONARIO' ELSE 'CLIENTE_EVENTO' END AS tipo
       FROM dars d
       LEFT JOIN permissionarios   p  ON p.id  = d.permissionario_id
       LEFT JOIN DARs_Eventos      de ON de.id_dar = d.id
       LEFT JOIN Eventos           e  ON e.id  = de.id_evento
       LEFT JOIN Clientes_Eventos  ce ON ce.id = e.id_cliente
      WHERE d.status = 'Pago'
        AND d.numero_documento IN (${pagos.map(() => '?').join(',')})
      ORDER BY d.data_pagamento DESC, d.id ASC`,
    pagos
  );

  console.table(relatorio);
}

if (require.main === module) {
  conciliarEListarPagos()
    .catch(e => console.error('[CONCILIA] ERRO:', e.message || e))
    .finally(() => db.close());
}
