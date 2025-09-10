#!/usr/bin/env node
/**
 * Ajusta DARs do evento 47 com suporte a:
 *  - Tabela de DAR com FK direta para evento  OU
 *  - Tabela de ligação (ex.: DARs_Eventos) entre DARs e Eventos
 *
 * Ações:
 * 1) Retirar a DAR 154 do evento 47 (cancelar/soft-delete + remover vínculo na join table se existir)
 * 2) Criar nova DAR p/ evento 47 com vencimento 29/10/2025 e valor R$ 1.247,50
 * 3) Criar DAR aleatória com vencimento anterior a hoje e marcar como PAGO no evento 47
 *
 * Uso: node ajustar_dars_evento47_v2.js /caminho/para/sistemacipt.db
 */

const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// ===== Helpers Promises =====
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

// ===== Utils =====
function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function toISO(dateStrBR) {
  const [d, m, y] = dateStrBR.split('/').map(x => parseInt(x, 10));
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function randomDateBefore(isoCutoff) {
  const cutoff = new Date(isoCutoff + 'T00:00:00').getTime();
  const min = cutoff - 60*24*3600*1000;
  const max = cutoff - 24*3600*1000;
  const t = Math.floor(Math.random()*(max-min+1)) + min;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function cents(n) { return Math.round(n*100); }

// ===== Schema detection =====
async function listTables(db) {
  return all(db, "SELECT name, sql FROM sqlite_master WHERE type='table'");
}
async function tableInfo(db, table) {
  return all(db, `PRAGMA table_info(${JSON.stringify(table).slice(1,-1)})`);
}
async function fkList(db, table) {
  try {
    return await all(db, `PRAGMA foreign_key_list(${JSON.stringify(table).slice(1,-1)})`);
  } catch {
    return [];
  }
}

async function detectDarTable(db) {
  const tables = await listTables(db);
  for (const t of tables) {
    const cols = await tableInfo(db, t.name);
    const names = cols.map(c => c.name.toLowerCase());
    const hasId = names.includes('id');
    const hasVenc = names.includes('data_vencimento');
    const hasLinha = names.includes('linha_digitavel');
    const hasCodigo = names.includes('codigo_barras') || names.includes('codigo_de_barras');
    const hasNumero = names.includes('numero_documento') || names.includes('numero') || names.includes('nosso_numero');
    const hasValor = names.includes('valor') || names.includes('valor_centavos') || names.includes('valor_total_centavos');
    const score = (hasId?2:0) + (hasVenc?3:0) + (hasLinha?1:0) + (hasCodigo?1:0) + (hasNumero?1:0) + (hasValor?2:0);
    if (score >= 6) {
      // provável tabela de DAR
      return { name: t.name, columns: cols, names };
    }
  }
  throw new Error("Não detectei a tabela de DAR (procure por data_vencimento/valor/linha_digitavel).");
}

function pickCol(names, candidates) {
  for (const c of candidates) if (names.includes(c)) return c;
  return null;
}

async function detectEventFKLocation(db, darTable) {
  // 1) procura FK direta em DARs
  const fkDirect = pickCol(darTable.names, ['evento_id', 'id_evento', 'event_id']);
  if (fkDirect) {
    return { mode: 'direct', fkCol: fkDirect };
  }

  // 2) procura tabela de ligação com colunas para dar e evento
  const tables = await listTables(db);
  for (const t of tables) {
    const cols = await tableInfo(db, t.name);
    const names = cols.map(c => c.name.toLowerCase());
    const darFK = pickCol(names, ['id_dar','dar_id','id_boleto','boleto_id']);
    const evtFK = pickCol(names, ['id_evento','evento_id','event_id']);
    if (darFK && evtFK) {
      // Parece ser a join table
      return { mode: 'join', table: t.name, darFK, evtFK, columns: cols, names };
    }
  }

  // 3) fallback: nenhum lugar encontrado
  return { mode: 'none' };
}

function columnByPattern(names, patterns) {
  return pickCol(names, patterns);
}

function buildSafeDefaults(col) {
  const name = col.name.toLowerCase();
  const type = (col.type || '').toUpperCase();
  // Preferir DEFAULT do banco
  if (col.dflt_value !== null && col.dflt_value !== undefined) return { useDefault: true };
  // ignora PK auto-increment
  if (col.pk) return { skip: true };
  // tenta heurística
  if (name.includes('created_at') || name.includes('updated_at')) return { value: todayISO() };
  if (name.includes('deleted_at')) return { skip: true };
  if (name.includes('ativo')) return { value: 1 };
  if (type.includes('INT')) return { value: 0 };
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return { value: 0 };
  if (type.includes('DATE') || type.includes('TIME')) return { value: todayISO() };
  // texto genérico
  return { value: '' };
}

// ===== Main =====
(async () => {
  const EVENTO_ID = 47;
  const DAR_ID_A_RETIRAR = 154;
  const NOVO_VENCIMENTO_BR = '29/10/2025';
  const NOVO_VALOR = 1247.50;

  try {
    const dbPath = process.argv[2];
    if (!dbPath) {
      console.error("Uso: node ajustar_dars_evento47_v2.js /caminho/para/sistemacipt.db");
      process.exit(1);
    }
    if (!fs.existsSync(dbPath)) {
      console.error("Banco não encontrado:", dbPath);
      process.exit(1);
    }
    const db = await openDB(dbPath);
    await run(db, "PRAGMA foreign_keys = ON");
    await run(db, "BEGIN IMMEDIATE TRANSACTION");

    // Detecta DARs
    const dar = await detectDarTable(db);
    const darCols = dar.columns;
    const darNames = dar.names;

    // Campos em DAR
    const idCol = 'id';
    const vencCol = 'data_vencimento';
    const statusCol = columnByPattern(darNames, ['status','situacao']);
    const pagoCol = columnByPattern(darNames, ['data_pagamento','pago_em']);
    const valorCol = columnByPattern(darNames, ['valor_centavos','valor_total_centavos','valor']);
    const numeroCol = columnByPattern(darNames, ['numero_documento','numero','nosso_numero']);
    const linhaCol  = columnByPattern(darNames, ['linha_digitavel']);
    const barrasCol = columnByPattern(darNames, ['codigo_barras','codigo_de_barras']);
    const ativoCol  = columnByPattern(darNames, ['ativo']);
    const createdAt = columnByPattern(darNames, ['created_at']);
    const updatedAt = columnByPattern(darNames, ['updated_at']);

    const loc = await detectEventFKLocation(db, dar);
    console.log(`Detectei tabela DAR: ${dar.name}`);
    console.log(`Vínculo evento: ${loc.mode === 'direct' ? `FK direta (${loc.fkCol})` : loc.mode === 'join' ? `join table ${loc.table} (${loc.darFK}<->${loc.evtFK})` : 'não encontrado'}`);

    // 1) Retirar DAR 154 do evento 47
    const dar154 = await get(db, `SELECT * FROM ${dar.name} WHERE ${idCol} = ?`, [DAR_ID_A_RETIRAR]);
    if (!dar154) {
      console.warn(`Aviso: DAR id=${DAR_ID_A_RETIRAR} não existe. Prosseguindo…`);
    } else {
      // cancela/soft-delete se possível
      const updates = [];
      const params = [];
      if (statusCol) { updates.push(`${statusCol}=?`); params.push('CANCELADA'); }
      if (ativoCol)  { updates.push(`${ativoCol}=?`);  params.push(0); }
      if (updatedAt) { updates.push(`${updatedAt}=?`); params.push(todayISO()); }
      if (updates.length) {
        await run(db, `UPDATE ${dar.name} SET ${updates.join(', ')} WHERE ${idCol}=?`, [...params, DAR_ID_A_RETIRAR]);
      }

      // remove vínculo na join table se existir
      if (loc.mode === 'join') {
        const del = await run(db, `DELETE FROM ${loc.table} WHERE ${loc.darFK}=? AND ${loc.evtFK}=?`, [DAR_ID_A_RETIRAR, EVENTO_ID]);
        console.log(`✔ Vínculo (DAR ${DAR_ID_A_RETIRAR} ↔ evento ${EVENTO_ID}) removido na join table.`);
      } else if (loc.mode === 'direct') {
        // desassocia FK se for nullable; se não for, não mexe aqui
        try {
          await run(db, `UPDATE ${dar.name} SET ${loc.fkCol}=NULL WHERE ${idCol}=? AND ${loc.fkCol}=?`, [DAR_ID_A_RETIRAR, EVENTO_ID]);
          console.log(`✔ DAR ${DAR_ID_A_RETIRAR} desassociada do evento ${EVENTO_ID}.`);
        } catch (e) {
          console.warn(`Aviso: não foi possível desassociar FK direta (${e.message}).`);
        }
      }
      console.log(`✔ DAR ${DAR_ID_A_RETIRAR} marcada como retirada (cancelada/inativa).`);
    }

    // 2) Criar nova DAR p/ evento 47
    const nowISO = todayISO();
    const vencISO = toISO(NOVO_VENCIMENTO_BR);
    const unique = `${Date.now()}-${Math.floor(Math.random()*1e4)}`;

    const insCols = [vencCol];
    const insVals = [vencISO];
    const ph = ['?'];

    if (valorCol) {
      if (valorCol.includes('centavos')) { insCols.push(valorCol); insVals.push(cents(NOVO_VALOR)); ph.push('?'); }
      else { insCols.push(valorCol); insVals.push(NOVO_VALOR); ph.push('?'); }
    }
    if (statusCol) { insCols.push(statusCol); insVals.push('EMITIDO'); ph.push('?'); }
    if (numeroCol) { insCols.push(numeroCol); insVals.push(`EVT${EVENTO_ID}-${unique}`); ph.push('?'); }
    if (linhaCol)  { insCols.push(linhaCol);  insVals.push(`LIN-${unique}`); ph.push('?'); }
    if (barrasCol) { insCols.push(barrasCol); insVals.push(`BAR-${unique}`); ph.push('?'); }
    if (createdAt) { insCols.push(createdAt); insVals.push(nowISO); ph.push('?'); }
    if (updatedAt) { insCols.push(updatedAt); insVals.push(nowISO); ph.push('?'); }

    // Preencher demais NOT NULL sem default
    const required = darCols.filter(c => c.notnull && !c.pk && !insCols.includes(c.name));
    for (const col of required) {
      const def = buildSafeDefaults(col);
      if (def.skip || def.useDefault) continue;
      insCols.push(col.name); insVals.push(def.value); ph.push('?');
    }

    const resNova = await run(db, `INSERT INTO ${dar.name} (${insCols.join(',')}) VALUES (${ph.join(',')})`, insVals);
    const novaDarId = resNova.lastID;

    // Vincular ao evento
    if (loc.mode === 'join') {
      // inserir na join table preenchendo not nulls
      const jCols = await tableInfo(db, loc.table);
      const jNames = jCols.map(c => c.name.toLowerCase());
      const cols = [loc.darFK, loc.evtFK];
      const vals = [novaDarId, EVENTO_ID];
      const jph = ['?','?'];

      for (const col of jCols) {
        if (cols.includes(col.name)) continue;
        if (!col.notnull || col.pk || col.dflt_value !== null) continue;
        const def = buildSafeDefaults(col);
        if (def.skip) continue;
        cols.push(col.name);
        vals.push(def.value);
        jph.push('?');
      }

      await run(db, `INSERT INTO ${loc.table} (${cols.join(',')}) VALUES (${jph.join(',')})`, vals);
    } else if (loc.mode === 'direct') {
      await run(db, `UPDATE ${dar.name} SET ${loc.fkCol}=? WHERE ${idCol}=?`, [EVENTO_ID, novaDarId]);
    } else {
      console.warn("⚠ Não encontrei onde vincular o evento. A DAR foi criada, mas não vinculada.");
    }
    console.log(`✔ Nova DAR criada (id=${novaDarId}) para o evento ${EVENTO_ID} com vencimento ${vencISO} e valor R$ ${NOVO_VALOR.toFixed(2)}.`);

    // 3) DAR aleatória paga antes de hoje
    const hoje = todayISO();
    const vencAle = randomDateBefore(hoje);
    const valorAle = Math.round((100 + Math.random()*1900)*100)/100;

    const ins2Cols = [vencCol];
    const ins2Vals = [vencAle];
    const ph2 = ['?'];
    if (valorCol) {
      if (valorCol.includes('centavos')) { ins2Cols.push(valorCol); ins2Vals.push(cents(valorAle)); ph2.push('?'); }
      else { ins2Cols.push(valorCol); ins2Vals.push(valorAle); ph2.push('?'); }
    }
    if (statusCol) { ins2Cols.push(statusCol); ins2Vals.push('PAGO'); ph2.push('?'); }
    if (pagoCol) { ins2Cols.push(pagoCol); ins2Vals.push(vencAle); ph2.push('?'); }
    if (numeroCol) { ins2Cols.push(numeroCol); ins2Vals.push(`PAGO-${unique}`); ph2.push('?'); }
    if (linhaCol)  { ins2Cols.push(linhaCol);  ins2Vals.push(`LIN-${unique}`); ph2.push('?'); }
    if (barrasCol) { ins2Cols.push(barrasCol); ins2Vals.push(`BAR-${unique}`); ph2.push('?'); }
    if (createdAt) { ins2Cols.push(createdAt); ins2Vals.push(nowISO); ph2.push('?'); }
    if (updatedAt) { ins2Cols.push(updatedAt); ins2Vals.push(nowISO); ph2.push('?'); }

    const required2 = darCols.filter(c => c.notnull && !c.pk && !ins2Cols.includes(c.name));
    for (const col of required2) {
      const def = buildSafeDefaults(col);
      if (def.skip || def.useDefault) continue;
      ins2Cols.push(col.name); ins2Vals.push(def.value); ph2.push('?');
    }

    const resPago = await run(db, `INSERT INTO ${dar.name} (${ins2Cols.join(',')}) VALUES (${ph2.join(',')})`, ins2Vals);
    const pagoId = resPago.lastID;

    if (loc.mode === 'join') {
      const jCols2 = await tableInfo(db, loc.table);
      const cols2 = [loc.darFK, loc.evtFK];
      const vals2 = [pagoId, EVENTO_ID];
      const phj2 = ['?','?'];
      for (const col of jCols2) {
        if (cols2.includes(col.name)) continue;
        if (!col.notnull || col.pk || col.dflt_value !== null) continue;
        const def = buildSafeDefaults(col);
        if (def.skip) continue;
        cols2.push(col.name);
        vals2.push(def.value);
        phj2.push('?');
      }
      await run(db, `INSERT INTO ${loc.table} (${cols2.join(',')}) VALUES (${phj2.join(',')})`, vals2);
    } else if (loc.mode === 'direct') {
      await run(db, `UPDATE ${dar.name} SET ${loc.fkCol}=? WHERE ${idCol}=?`, [EVENTO_ID, pagoId]);
    }

    console.log(`✔ DAR paga criada (id=${pagoId}) com vencimento ${vencAle} (antes de hoje) vinculada ao evento ${EVENTO_ID}.`);

    await run(db, "COMMIT");
    console.log("✅ Concluído com sucesso.");
    db.close();
  } catch (err) {
    console.error("❌ Erro:", err.message);
    try { await run(db, "ROLLBACK"); } catch {}
    process.exit(1);
  }
})();
