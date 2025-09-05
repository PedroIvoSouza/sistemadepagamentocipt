const db = require('../database/db');
const { toISO } = require('../utils/sefazPayload');

const dbRunAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));

async function atualizarDataPagamento(darId, dataPagamento) {
  const iso = toISO(dataPagamento);
  if (!iso) return;
  await dbRunAsync(`UPDATE dars SET data_pagamento = ? WHERE id = ?`, [iso, darId]);
}

module.exports = { atualizarDataPagamento };
