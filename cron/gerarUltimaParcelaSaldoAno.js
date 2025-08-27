#!/usr/bin/env node
// gerarUltimaParcelaSaldoAno.js
// Uso: node gerarUltimaParcelaSaldoAno.js 2025 ./db.sqlite --dry-run

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const ano   = process.argv[2] || String(new Date().getFullYear());
const DB    = process.argv[3] || './db.sqlite';
const DRY   = process.argv.includes('--dry-run');

if (!fs.existsSync(DB)) {
  console.error(`DB não encontrado: ${DB}`);
  process.exit(1);
}

// ============ Helpers de DB (mesmo padrão do conciliador) ============
const db = new sqlite3.Database(DB);
function dbAll(sql, p=[]) { return new Promise((res, rej)=> db.all(sql, p, (e,r)=> e?rej(e):res(r||[]))); }
function dbGet(sql, p=[]) { return new Promise((res, rej)=> db.get(sql, p, (e,r)=> e?rej(e):res(r))); }
function dbRun(sql, p=[]) { return new Promise((res, rej)=> db.run(sql, p, function(e){ e?rej(e):res(this); })); }

// ============ Datas / dias úteis (mesma regra de feriados fixos do front) ============
const feriadosFixos = ['01/01','21/04','01/05','24/06','07/09','16/09','12/10','02/11','15/11','25/12']; // :contentReference[oaicite:4]{index=4}
const isFeriado = d => feriadosFixos.includes(`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`);
const isDiaUtil = d => d.getDay() !== 0 && d.getDay() !== 6 && !isFeriado(d);
function ymd(d){ const off = new Date(d.getTime()-d.getTimezoneOffset()*60000); return off.toISOString().slice(0,10); }
function proximoDiaUtilDesde(base = new Date(), addDias = 1){
  const d = new Date(base); d.setDate(d.getDate() + addDias);
  while (!isDiaUtil(d)) d.setDate(d.getDate()+1);
  return ymd(d);
}

// ============ Utilitários ============
function round2(n){ return Math.round(Number(n||0)*100)/100; }
function approxEq(a,b,eps=0.01){ return Math.abs(Number(a)-Number(b)) <= eps; }

async function getCols(tabela){
  const rows = await dbAll(`PRAGMA table_info(${tabela})`);
  return rows.map(r => r.name);
}

async function main(){
  console.log(`[SALDO] Gerando “parcela final” para eventos com pagamentos em ${ano}${DRY?' (dry-run)':''}…`);

  // 1) Candidatos: têm ≥1 pagamento no ano e saldo > 0
  const cand = await dbAll(`
    WITH pagos AS (
      SELECT
        e.id AS id_evento, e.nome_evento, e.valor_final,
        COUNT(de.id_dar) AS qtd_parcelas,
        SUM(CASE WHEN d.status='Pago' THEN 1 ELSE 0 END) AS qtd_pagas,
        ROUND(SUM(de.valor_parcela), 2) AS total_parcelado,
        ROUND(SUM(CASE WHEN d.status='Pago' THEN de.valor_parcela ELSE 0 END), 2) AS total_pago
      FROM Eventos e
      JOIN DARs_Eventos de ON de.id_evento = e.id
      JOIN dars d          ON d.id        = de.id_dar
      WHERE COALESCE(e.evento_gratuito, 0) = 0
        AND strftime('%Y', d.data_pagamento) = ?
      GROUP BY e.id
    )
    SELECT
      id_evento, nome_evento, valor_final, qtd_parcelas, qtd_pagas, total_parcelado, total_pago,
      ROUND(valor_final - total_pago, 2) AS saldo
    FROM pagos
    WHERE qtd_pagas >= 1
      AND ROUND(valor_final - total_pago, 2) > 0.009
    ORDER BY saldo DESC, nome_evento
  `, [ano]);

  if (!cand.length){
    console.log('[SALDO] Nenhum evento com saldo > 0 encontrado.');
    process.exit(0);
  }

  const darsCols = await getCols('dars');
  const linkCols = await getCols('DARs_Eventos');
  const tem = c => darsCols.includes(c);

  let criadas = 0;

  for (const ev of cand){
    const { id_evento, nome_evento, valor_final, total_pago, saldo } = ev;

    // Já existe DAR em aberto aproximadamente = saldo?
    const existente = await dbGet(`
      SELECT d.id, d.valor, d.status
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      WHERE de.id_evento = ?
        AND d.status != 'Pago'
      ORDER BY ABS(ROUND(d.valor*100) - ROUND(?*100)) ASC
      LIMIT 1
    `, [id_evento, saldo]);

    if (existente && approxEq(existente.valor, saldo)) {
      console.log(`- [pula] #${id_evento} "${nome_evento}" já tem DAR em aberto ≈ saldo (id=${existente.id}, valor=${existente.valor}).`);
      continue;
    }

    // numero_parcela = MAX + 1
    const seq = await dbGet(`SELECT COALESCE(MAX(numero_parcela), 0)+1 AS prox FROM DARs_Eventos WHERE id_evento = ?`, [id_evento]);
    const numero_parcela = seq?.prox || 1;

    // “Herda” alguns campos da DAR mais recente do evento (se existirem na tabela)
    const modelo = await dbGet(`
      SELECT d.*
      FROM dars d
      JOIN DARs_Eventos de ON de.id_dar = d.id
      WHERE de.id_evento = ?
      ORDER BY d.id DESC
      LIMIT 1
    `, [id_evento]) || {};

    const venc = proximoDiaUtilDesde(new Date(), 1); // próximo dia útil a partir de amanhã

    // Monta INSERT dinâmico na tabela dars
    const payload = {
      valor: round2(saldo),
      data_vencimento: venc,
      status: 'Emitido',                    // ajuste se preferir 'Pendente'
      descricao: `Parcela Final (Saldo) — Evento ${id_evento}`,
      codigo_receita: modelo.codigo_receita ?? null,
      permissionario_id: null,
      numero_documento: null,
      codigo_barras: null,
      linha_digitavel: null,
    };

    // Filtra apenas colunas que existem de fato
    const cols = Object.keys(payload).filter(k => darsCols.includes(k));
    const vals = cols.map(k => payload[k]);

    if (DRY) {
      console.log(`- [dry] #${id_evento} "${nome_evento}": saldo=R$ ${saldo.toFixed(2)} → DAR(new) venc=${venc} | parcela #${numero_parcela}`);
      continue;
    }

    await dbRun('BEGIN');
    try {
      const placeholders = cols.map(()=>'?').join(',');
      const ins = await dbRun(`INSERT INTO dars (${cols.join(',')}) VALUES (${placeholders})`, vals);
      const novoDarId = ins.lastID;

      // Linka em DARs_Eventos
      const linkColsSafe = ['id_evento','id_dar','numero_parcela','valor_parcela','data_vencimento']
        .filter(c => linkCols.includes(c));
      const linkVals = {
        id_evento,
        id_dar: novoDarId,
        numero_parcela,
        valor_parcela: round2(saldo),
        data_vencimento: venc
      };
      const linkParams = linkColsSafe.map(c => linkVals[c]);

      await dbRun(
        `INSERT INTO DARs_Eventos (${linkColsSafe.join(',')}) VALUES (${linkColsSafe.map(()=>'?').join(',')})`,
        linkParams
      );

      await dbRun('COMMIT');
      criadas++;
      console.log(`+ [ok] #${id_evento} "${nome_evento}": criada DAR ${novoDarId} (Parcela Final #${numero_parcela}, R$ ${saldo.toFixed(2)}, venc ${venc})`);
    } catch (e) {
      await dbRun('ROLLBACK');
      console.error(`! [erro] Evento #${id_evento} "${nome_evento}": ${e.message}`);
    }
  }

  console.log(`\n[SALDO] Concluído. Novas DARs criadas: ${criadas}.${DRY?' (dry-run)':''}`);
  db.close();
}

main().catch(e => { console.error(e); db.close(); process.exit(1); });
