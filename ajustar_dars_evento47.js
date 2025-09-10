#!/usr/bin/env node
/**
 * Ajusta DARs do evento 47:
 * - "Retira" (cancela ou desassocia) a DAR id=154 do evento 47
 * - Cria nova DAR com vencimento 29/10/2025 no valor de R$ 1.247,50
 * - Cria outra DAR aleatória com vencimento anterior à data de hoje e marca como paga
 *
 * Uso:
 *   node ajustar_dars_evento47.js /caminho/para/sistemacipt.db
 *
 * Requisitos: Node 18+ e pacote 'sqlite3' (npm i sqlite3)
 * Observação: O script tenta detectar dinamicamente a tabela de DAR e os nomes das colunas mais comuns.
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ====== Helpers de Promises para sqlite3 ======
function openDB(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  }));
}

// ====== Utilidades ======
function todayISO() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function toISO(dateStrBR) {
  // espera "DD/MM/AAAA"
  const [d, m, y] = dateStrBR.split('/').map(s => parseInt(s, 10));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function randomDateBefore(isoCutoff) {
  const cutoff = new Date(isoCutoff + 'T00:00:00Z').getTime();
  // pegue uma data aleatória entre (cutoff - 60 dias) e (cutoff - 1 dia)
  const min = cutoff - 60 * 24 * 3600 * 1000;
  const max = cutoff - 24 * 3600 * 1000;
  const t = Math.floor(Math.random() * (max - min + 1)) + min;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function cents(n) {
  return Math.round(n * 100);
}

// ====== Descobrir a tabela de DAR e colunas ======
async function detectDarTable(db) {
  const tables = await all(db, "SELECT name, sql FROM sqlite_master WHERE type='table'");
  let best = null;

  for (const t of tables) {
    const cols = await all(db, `PRAGMA table_info(${JSON.stringify(t.name).slice(1,-1)})`);
    const colnames = cols.map(c => c.name.toLowerCase());
    const hasId = colnames.includes('id');
    const hasDataVenc = colnames.includes('data_vencimento');
    const hasNumero = colnames.includes('numero_documento') || colnames.includes('numero') || colnames.includes('nosso_numero');
    const hasLinha = colnames.includes('linha_digitavel');
    const hasCodigo = colnames.includes('codigo_barras') || colnames.includes('codigo_de_barras');
    const hasEvento = colnames.includes('evento_id') || colnames.includes('id_evento') || colnames.includes('event_id');

    // heurística simples: precisa ter id e data_vencimento, e alguma identidade/linha/codigo e o FK de evento
    const score =
      (hasId ? 2 : 0) +
      (hasDataVenc ? 3 : 0) +
      (hasNumero ? 2 : 0) +
      (hasLinha ? 1 : 0) +
      (hasCodigo ? 1 : 0) +
      (hasEvento ? 3 : 0);

    if (score >= 7) {
      // elegível
      const map = {
        table: t.name,
        columns: cols,
        colset: new Set(colnames),
        fkEvento:
          colnames.includes('evento_id') ? 'evento_id' :
          colnames.includes('id_evento') ? 'id_evento' :
          colnames.includes('event_id') ? 'event_id' : null,
        valorCol: colnames.includes('valor_centavos') ? 'valor_centavos' :
                  colnames.includes('valor_total_centavos') ? 'valor_total_centavos' :
                  colnames.includes('valor') ? 'valor' : null,
        statusCol: colnames.includes('status') ? 'status' :
                   colnames.includes('situacao') ? 'situacao' : null,
        pagoEmCol: colnames.includes('data_pagamento') ? 'data_pagamento' :
                   colnames.includes('pago_em') ? 'pago_em' : null,
        ativoCol: colnames.includes('ativo') ? 'ativo' : null,
        deletadoCol: colnames.includes('deleted_at') ? 'deleted_at' : null,
        numeroCol: colnames.includes('numero_documento') ? 'numero_documento' :
                   colnames.includes('numero') ? 'numero' :
                   colnames.includes('nosso_numero') ? 'nosso_numero' : null,
        linhaCol: colnames.includes('linha_digitavel') ? 'linha_digitavel' : null,
        barrasCol: colnames.includes('codigo_barras') ? 'codigo_barras' :
                   colnames.includes('codigo_de_barras') ? 'codigo_de_barras' : null,
        createdAtCol: colnames.includes('created_at') ? 'created_at' : null,
        updatedAtCol: colnames.includes('updated_at') ? 'updated_at' : null
      };
      best = map;
      break;
    }
  }

  if (!best) {
    throw new Error("Não foi possível detectar a tabela de DAR automaticamente. Ajuste o script para o seu schema.");
  }
  return best;
}

// ====== Core ======
(async () => {
  try {
    const dbPath = process.argv[2];
    if (!dbPath) {
      console.error("Uso: node ajustar_dars_evento47.js /caminho/para/sistemacipt.db");
      process.exit(1);
    }
    if (!fs.existsSync(dbPath)) {
      console.error("Arquivo do banco não encontrado:", dbPath);
      process.exit(1);
    }

    const db = await openDB(dbPath);
    const start = Date.now();
    await run(db, "BEGIN IMMEDIATE TRANSACTION");

    const dar = await detectDarTable(db);
    const {
      table, fkEvento, valorCol, statusCol, pagoEmCol, ativoCol, deletadoCol,
      numeroCol, linhaCol, barrasCol, createdAtCol, updatedAtCol
    } = dar;

    const EVENTO_ID = 47;
    const DAR_ID_A_RETIRAR = 154;

    // 1) "Retirar" a DAR 154 do evento 47
    const dar154 = await get(db, `SELECT * FROM ${table} WHERE id = ? AND ${fkEvento} = ?`, [DAR_ID_A_RETIRAR, EVENTO_ID]);
    if (!dar154) {
      console.warn(`Aviso: Não encontrei DAR id=${DAR_ID_A_RETIRAR} vinculada ao evento ${EVENTO_ID}. Prosseguindo…`);
    } else {
      // Preferir cancelamento/soft-delete
      let updates = [];
      let params = [];
      if (statusCol) { updates.push(`${statusCol} = ?`); params.push('CANCELADA'); }
      if (ativoCol)  { updates.push(`${ativoCol} = ?`);  params.push(0); }
      if (deletadoCol) { updates.push(`${deletadoCol} = datetime('now')`); }
      if (updates.length === 0) {
        // fallback: desassociar do evento para "retirar"
        updates.push(`${fkEvento} = NULL`);
      }
      const sql = `UPDATE ${table} SET ${updates.join(', ')} WHERE id = ? AND ${fkEvento} = ?`;
      await run(db, sql, [...params, DAR_ID_A_RETIRAR, EVENTO_ID]);
      console.log(`✔ DAR ${DAR_ID_A_RETIRAR} marcada como retirada/cancelada (ou desassociada).`);
    }

    // 2) Inserir nova DAR com vencimento 29/10/2025 e valor R$ 1.247,50
    const vencISO = toISO('29/10/2025');
    const valorReais = 1247.50;
    const nowISO = todayISO();

    // Gerar campos identificadores se necessários
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const numeroGerado = `EVT${EVENTO_ID}-${uniqueSuffix}`;
    const linhaGerada = `LINHA-${uniqueSuffix}`;
    const barrasGerado = `CODB-${uniqueSuffix}`;

    // Montar insert dinamicamente
    const insertCols = [fkEvento, 'data_vencimento'];
    const insertVals = [EVENTO_ID, vencISO];
    const placeholders = ['?', '?'];

    if (valorCol) {
      if (valorCol.toLowerCase().includes('centavos')) {
        insertCols.push(valorCol); insertVals.push(cents(valorReais)); placeholders.push('?');
      } else {
        insertCols.push(valorCol); insertVals.push(valorReais); placeholders.push('?');
      }
    }
    if (statusCol) { insertCols.push(statusCol); insertVals.push('EMITIDO'); placeholders.push('?'); }
    if (numeroCol) { insertCols.push(numeroCol); insertVals.push(numeroGerado); placeholders.push('?'); }
    if (linhaCol)  { insertCols.push(linhaCol);  insertVals.push(linhaGerada); placeholders.push('?'); }
    if (barrasCol) { insertCols.push(barrasCol); insertVals.push(barrasGerado); placeholders.push('?'); }
    if (createdAtCol) { insertCols.push(createdAtCol); insertVals.push(nowISO); placeholders.push('?'); }
    if (updatedAtCol) { insertCols.push(updatedAtCol); insertVals.push(nowISO); placeholders.push('?'); }

    const sqlInsNova = `INSERT INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`;
    const resNova = await run(db, sqlInsNova, insertVals);
    const novaDarId = resNova.lastID;
    console.log(`✔ Nova DAR criada (id=${novaDarId}) para o evento ${EVENTO_ID} com vencimento ${vencISO} e valor R$ ${valorReais.toFixed(2)}.`);

    // 3) Inserir DAR aleatória com vencimento anterior a hoje e marcar como paga
    const hojeISO = todayISO();
    const vencAleatorioISO = randomDateBefore(hojeISO);
    const valorAleatorio = Math.round((100 + Math.random() * 1900) * 100) / 100; // R$ 100,00 a R$ 2000,00
    const pagoEmISO = vencAleatorioISO; // pago na data de vencimento (ajuste se quiser)

    const insertCols2 = [fkEvento, 'data_vencimento'];
    const insertVals2 = [EVENTO_ID, vencAleatorioISO];
    const placeholders2 = ['?', '?'];

    if (valorCol) {
      if (valorCol.toLowerCase().includes('centavos')) {
        insertCols2.push(valorCol); insertVals2.push(cents(valorAleatorio)); placeholders2.push('?');
      } else {
        insertCols2.push(valorCol); insertVals2.push(valorAleatorio); placeholders2.push('?');
      }
    }
    if (statusCol) { insertCols2.push(statusCol); insertVals2.push('PAGO'); placeholders2.push('?'); }
    if (pagoEmCol) { insertCols2.push(pagoEmCol); insertVals2.push(pagoEmISO); placeholders2.push('?'); }
    if (numeroCol) { insertCols2.push(numeroCol); insertVals2.push(`PAGO-${uniqueSuffix}`); placeholders2.push('?'); }
    if (linhaCol)  { insertCols2.push(linhaCol);  insertVals2.push(`LIN-${uniqueSuffix}`); placeholders2.push('?'); }
    if (barrasCol) { insertCols2.push(barrasCol); insertVals2.push(`BAR-${uniqueSuffix}`); placeholders2.push('?'); }
    if (createdAtCol) { insertCols2.push(createdAtCol); insertVals2.push(nowISO); placeholders2.push('?'); }
    if (updatedAtCol) { insertCols2.push(updatedAtCol); insertVals2.push(nowISO); placeholders2.push('?'); }

    const sqlInsPago = `INSERT INTO ${table} (${insertCols2.join(', ')}) VALUES (${placeholders2.join(', ')})`;
    const resPago = await run(db, sqlInsPago, insertVals2);
    const pagoId = resPago.lastID;
    console.log(`✔ DAR paga criada (id=${pagoId}) com vencimento ${vencAleatorioISO} e valor R$ ${valorAleatorio.toFixed(2)}.`);

    await run(db, "COMMIT");
    const ms = Date.now() - start;
    console.log(`✅ Concluído em ${ms}ms.`);
    db.close();
  } catch (err) {
    console.error("❌ Erro:", err.message);
    try { await run(db, "ROLLBACK"); } catch {}
    process.exit(1);
  }
})();
