#!/usr/bin/env node
/**
 * Preenche campos de endereço (logradouro/bairro/cidade/uf) nas tabelas
 * `Clientes_Eventos` e `Clientes` usando o CEP informado.
 * Seleciona apenas registros sem logradouro e com CEP válido.
 *
 * Uso:
 *   node scripts/backfillClienteEnderecos.js
 *
 * É seguro reexecutar: registros já preenchidos serão ignorados.
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
} catch {}
const sqlite3 = require('sqlite3').verbose();
const { fetchCepAddress } = require('../src/services/cepLookupService');

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

const db = new sqlite3.Database(DB_PATH);

const qAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});
const qRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve(this);
  });
});

async function backfill(table) {
  const cols = await qAll(`PRAGMA table_info('${table}')`);
  const has = name => cols.some(c => c.name === name);
  const cidadeCol = has('cidade') ? 'cidade' : (has('localidade') ? 'localidade' : null);

  const rows = await qAll(
    `SELECT id, cep FROM ${table} WHERE (cep IS NOT NULL AND TRIM(cep) <> '') AND (logradouro IS NULL OR TRIM(logradouro) = '')`
  );
  console.log(`[INFO] ${table}: ${rows.length} registros candidatos`);

  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const addr = await fetchCepAddress(r.cep);
      const setParts = [];
      const params = [];
      if (has('logradouro')) { setParts.push('logradouro = ?'); params.push(addr.logradouro || null); }
      if (has('bairro')) { setParts.push('bairro = ?'); params.push(addr.bairro || null); }
      if (cidadeCol) { setParts.push(`${cidadeCol} = ?`); params.push(addr.localidade || null); }
      if (has('uf')) { setParts.push('uf = ?'); params.push(addr.uf || null); }
      if (has('endereco')) { setParts.push('endereco = COALESCE(endereco, ?)'); params.push(addr.logradouro || null); }
      if (setParts.length === 0) continue;
      params.push(r.id);
      const sql = `UPDATE ${table} SET ${setParts.join(', ')} WHERE id = ?`;
      await qRun(sql, params);
      ok++;
    } catch (e) {
      console.error(`[ERRO] ${table} id=${r.id} cep=${r.cep}: ${e.message}`);
      fail++;
    }
  }
  console.log(`[RESUMO] ${table}: atualizados=${ok} falhas=${fail}`);
  return { ok, fail };
}

(async () => {
  try {
    const a = await backfill('Clientes_Eventos');
    const b = await backfill('Clientes');
    console.log(`[DONE] totalAtualizados=${a.ok + b.ok} totalFalhas=${a.fail + b.fail}`);
  } catch (err) {
    console.error('Erro geral:', err.message);
  } finally {
    db.close();
  }
})();
