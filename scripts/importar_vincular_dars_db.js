#!/usr/bin/env node
/**
 * Importa/atualiza Clientes_Eventos, Eventos e cria/vincula DARs a partir de um XLSX.
 * NÃO LÊ CSV.
 *
 * Uso:
 *  node scripts/importar_vincular_dars_db_xlsx.js \
 *    --in scripts/plano_final_para_importar_e_emitir.xlsx \
 *    --db ./sistemacipt.db \
 *    [--sheet "Aba 1"] \
 *    [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const minimist = require('minimist');
const XLSX = require('xlsx');

const args = minimist(process.argv.slice(2), {
  string: ['in','db','sheet'],
  boolean: ['dry-run'],
  default: { 'dry-run': false, db: './sistemacipt.db' }
});

if (!args.in) {
  console.error('Erro: informe --in com o caminho do .xlsx');
  process.exit(1);
}
if (path.extname(args.in).toLowerCase() !== '.xlsx') {
  console.error('Erro: este script aceita somente .xlsx');
  process.exit(1);
}

const INPUT = args.in;
const SHEET = args.sheet || null;
const DB_PATH = args.db;
const DRY = !!args['dry-run'];

// ----------------- helpers -----------------
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const normDoc = (doc) => onlyDigits(doc);
const cnpjRaiz = (doc) => (onlyDigits(doc).length === 14 ? onlyDigits(doc).slice(0,8) : '');
const tipoPessoa = (doc) => (onlyDigits(doc).length === 14 ? 'PJ' : 'PF');

function toNum(x) {
  if (x === null || x === undefined) return NaN;
  let s = String(x).trim();
  if (!s) return NaN;
  s = s.replace(/[R$\s\u00A0]/gi, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function iso(s) {
  if (!s) return '';
  const t = String(s).trim();
  // se veio como número do Excel (serial date)
  if (!isNaN(Number(t)) && Number(t) > 25000) {
    const jsDate = XLSX.SSF.parse_date_code(Number(t));
    const y = String(jsDate.y).padStart(4, '0');
    const m = String(jsDate.m).padStart(2, '0');
    const d = String(jsDate.d).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [_, d, mo, y] = m;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  return '';
}

// Normaliza "E:30010.0000000592/2024" -> "30010.592/2024"
function normProc(proc) {
  if (!proc) return '';
  let up = String(proc).toUpperCase().trim();
  up = up.replace(/^E:/,'').replace(/\s+/g,'');
  const m = up.match(/^(\d+)\.(\d+)\/(\d{4})$/);
  if (!m) {
    const m2 = up.match(/(\d{4})$/);
    const ano = m2 ? m2[1] : null;
    let base = null, seq = null;
    const baseSeq = up.replace(/\/?\d{4}$/,'');
    if (baseSeq.includes('.')) [base, seq] = baseSeq.split('.');
    if (seq) seq = seq.replace(/^0+/,'') || '0';
    return (base && ano) ? `${base}.${seq}/${ano}` : up;
  }
  const [, base, seq, ano] = m;
  const seqn = String(seq).replace(/^0+/,'') || '0';
  return `${base}.${seqn}/${ano}`;
}

function pick(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

const arrUniq = (a) => [...new Set(a.filter(Boolean))];

// ----------------- XLSX reader -----------------
function readXlsxAsObjects(file, sheetName = null) {
  const wb = XLSX.read(fs.readFileSync(file));
  const ws = wb.Sheets[sheetName || wb.SheetNames[0]];
  if (!ws) throw new Error(`Aba não encontrada: ${sheetName || '(primeira aba)'}`);
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// ----------------- DB helpers (promises) -----------------
function dbRun(db, sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){
      if (err) return reject(err);
      resolve(this); // this.lastID, this.changes
    });
  });
}
function dbGet(db, sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function(err, row){
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}
function dbAll(db, sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function(err, rows){
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// ----------------- Upserts & criação -----------------
async function ensureCliente(db, { nome, doc, email }) {
  const documento_norm = normDoc(doc);
  const documento_raiz = cnpjRaiz(doc);
  const tp = tipoPessoa(doc);

  let row = await dbGet(db,
    `SELECT id FROM Clientes_Eventos WHERE documento_norm = ? OR documento = ? LIMIT 1`,
    [documento_norm, doc]
  );
  if (row) return row.id;

  if (DRY) { console.log(`[dry] Criaria cliente: ${nome} (${doc})`); return -1; }

  const res = await dbRun(db, `
    INSERT INTO Clientes_Eventos
      (nome_razao_social, tipo_pessoa, documento, email, documento_norm, documento_raiz, tipo_cliente)
    VALUES (?,?,?,?,?,?, 'Geral')
  `, [nome || 'Cliente sem nome', tp, doc, email || 'sem-email@exemplo.com', documento_norm, documento_raiz]);
  return res.lastID;
}

async function findEventoByProc(db, numero_processo) {
  const np = normProc(numero_processo);
  const all = await dbAll(db, `
    SELECT id, numero_processo FROM Eventos
    WHERE UPPER(REPLACE(REPLACE(numero_processo,'E:',''),' ','')) LIKE ?`, [`%/${np.slice(-4)}%`]);
  for (const r of all) {
    if (normProc(r.numero_processo) === np) return r.id;
  }
  return null;
}

async function ensureEvento(db, { id_cliente, nome_evento, numero_processo, datas_evento_list, valor_total }) {
  let id = numero_processo ? await findEventoByProc(db, numero_processo) : null;

  if (!id && numero_processo) {
    const ano = (numero_processo.match(/(\d{4})$/)||[])[1] || '';
    const row = await dbGet(db, `
      SELECT id FROM Eventos
       WHERE id_cliente = ? AND UPPER(nome_evento)=UPPER(?)
         AND (numero_processo LIKE ? OR numero_processo LIKE ?)
       LIMIT 1
    `, [id_cliente, nome_evento, `%/${ano}`, `%${ano}`]);
    if (row) id = row.id;
  }
  if (id) return id;

  const datas = arrUniq(datas_evento_list).map(iso).filter(Boolean);
  const datas_evento = datas.join(';') || new Date().toISOString().slice(0,10);
  const total_diarias = datas.length || 1;
  const valor = Number(isNaN(valor_total)?0:valor_total);

  if (DRY) {
    console.log(`[dry] Criaria evento: ${nome_evento} (${numero_processo||'sem processo'}) diárias=${total_diarias} total=${valor.toFixed(2)}`);
    return -1;
  }

  const res = await dbRun(db, `
    INSERT INTO Eventos
      (id_cliente, nome_evento, datas_evento, total_diarias,
       valor_bruto, valor_final, status, numero_processo)
    VALUES (?,?,?,?, ?, ?, 'Pendente', ?)
  `, [id_cliente, nome_evento, datas_evento, total_diarias, valor, valor, numero_processo || null]);

  return res.lastID;
}

async function findDarLinked(db, id_evento, numero_parcela, valor, data_venc) {
  const row = await dbGet(db, `
    SELECT d.id AS id_dar
      FROM DARs_Eventos de
      JOIN dars d ON d.id = de.id_dar
     WHERE de.id_evento = ?
       AND de.numero_parcela = ?
       AND d.data_vencimento = ?
       AND ABS(d.valor - ?) < 0.0001
     LIMIT 1
  `, [id_evento, Number(numero_parcela), data_venc, Number(valor)]);
  return row ? row.id_dar : null;
}

async function createDarAndLink(db, { id_evento, numero_parcela, valor, data_venc, pago, data_pagto }) {
  const existent = await findDarLinked(db, id_evento, numero_parcela, valor, data_venc);
  if (existent) return existent;

  let id_dar = null;

  if (!DRY) {
    const res = await dbRun(db, `
      INSERT INTO dars (valor, data_vencimento, status, tipo_permissionario)
      VALUES (?,?,?, 'Evento')
    `, [Number(valor), data_venc, pago ? 'Pago' : 'Pendente']);
    id_dar = res.lastID;

    if (pago && data_pagto) {
      await dbRun(db, `UPDATE dars SET data_pagamento = ? WHERE id = ?`, [data_pagto, id_dar]);
    }

    await dbRun(db, `
      INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
      VALUES (?,?,?,?,?)
    `, [id_evento, id_dar, Number(numero_parcela), Number(valor), data_venc]);
  } else {
    console.log(`[dry] Criaria DAR + vinc (evento=${id_evento}, parc=${numero_parcela}, valor=${valor}, venc=${data_venc}, pago=${pago})`);
    id_dar = -1;
  }

  return id_dar;
}

async function recomputeEventoStatus(db, id_evento) {
  const rows = await dbAll(db, `
    SELECT d.status FROM DARs_Eventos de
    JOIN dars d ON d.id = de.id_dar
    WHERE de.id_evento = ?`, [id_evento]);
  if (!rows.length) return;

  const total = rows.length;
  const pagos = rows.filter(r => r.status === 'Pago').length;

  let st = 'Pendente';
  if (pagos === 0) st = 'Pendente';
  else if (pagos < total) st = 'Pago Parcialmente';
  else st = 'Pago';

  if (!DRY) {
    await dbRun(db, `UPDATE Eventos SET status = ? WHERE id = ?`, [st, id_evento]);
  } else {
    console.log(`[dry] Atualizaria status do evento ${id_evento} -> ${st}`);
  }
}

// ----------------- main -----------------
(async function main(){
  // 1) Ler XLSX
  const plan = readXlsxAsObjects(INPUT, SHEET);

  // 2) Agrupar por evento
  const groups = new Map();
  for (const row of plan) {
    const cliente_nome = pick(row, 'cliente_nome','nome_cliente','empresa','empresa_plan','cliente');
    const cliente_doc  = pick(row, 'cliente_documento','documento','cnpj','cpf','doc');
    const cliente_email= pick(row, 'cliente_email','email','email_cliente');

    const evento_nome  = pick(row, 'evento_nome','nome_evento','titulo','titulo_evento') || pick(row,'empresa_plan') || 'Evento';
    const num_proc_raw = pick(row, 'numero_processo','processo','processo_norm','processo_plan');
    const numero_processo = num_proc_raw ? normProc(num_proc_raw) : '';

    const datas_str    = pick(row, 'datas_evento','datas','datas_previstas'); // "YYYY-MM-DD;YYYY-MM-DD"
    const parcela      = String(pick(row, 'parcela','numero_parcela','n_parcela') || '1').trim();
    const valor        = toNum(pick(row, 'valor','valor_parcela','valor_dar'));
    const venc         = iso(pick(row, 'data_vencimento','vencimento','data_venc','venc'));
    const pago         = String(pick(row,'pago','pago_plan') || 'Nao').toLowerCase().startsWith('s');
    const data_pagto   = iso(pick(row,'data_pagamento','pagamento_em','data_pg'));

    if (!cliente_doc) { console.log(`! Linha sem documento do cliente; pulando`); continue; }
    if (!Number.isFinite(valor) || !venc) { console.log(`! Linha inválida (valor/venc) para processo=${numero_processo||'(sem)'}; pulando`); continue; }

    const key = numero_processo || `${normDoc(cliente_doc)}|${evento_nome.toUpperCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        cliente: { nome: cliente_nome || 'Cliente', doc: cliente_doc, email: cliente_email || 'sem-email@exemplo.com' },
        evento:  { nome: evento_nome, numero_processo: numero_processo, datas_evento_list: [], parcelas: [] }
      });
    }
    const g = groups.get(key);
    if (datas_str) {
      const parts = String(datas_str).split(/[;,\s]+/).map(iso).filter(Boolean);
      g.evento.datas_evento_list.push(...parts);
    }
    g.evento.parcelas.push({ parcela, valor, venc, pago, data_pagto });
  }

  const db = new sqlite3.Database(DB_PATH);
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');

    let stats = { clientes:0, eventos:0, dars:0, links:0, atualizados:0 };

    for (const [key, bundle] of groups.entries()) {
      const { cliente, evento } = bundle;

      // 1) Cliente
      const id_cliente = await ensureCliente(db, cliente);
      if (id_cliente > 0) stats.clientes++;

      // 2) Evento (valor_total = soma das parcelas)
      const valor_total = (evento.parcelas.reduce((acc, p) => acc + (Number(p.valor)||0), 0)) || 0;
      const id_evento = await ensureEvento(db, {
        id_cliente,
        nome_evento: evento.nome,
        numero_processo: evento.numero_processo,
        datas_evento_list: evento.datas_evento_list,
        valor_total
      });
      if (id_evento > 0) stats.eventos++;

      // 3) DARs + vínculos
      for (const p of evento.parcelas) {
        const id_dar = await createDarAndLink(db, {
          id_evento,
          numero_parcela: p.parcela,
          valor: p.valor,
          data_venc: p.venc,
          pago: p.pago,
          data_pagto: p.data_pagto
        });
        if (id_dar > 0) { stats.dars++; stats.links++; }
      }

      // 4) Status do evento
      await recomputeEventoStatus(db, id_evento);
      stats.atualizados++;
      console.log(`✓ Evento ${id_evento} processado (${evento.numero_processo || key})`);
    }

    if (DRY) {
      console.log('DRY-RUN ativo — efetivação CANCELADA');
      await dbRun(db, 'ROLLBACK');
    } else {
      await dbRun(db, 'COMMIT');
    }

    console.log('\n--- RESUMO ---');
    console.log(`Clientes criados:     ${stats.clientes}`);
    console.log(`Eventos criados:      ${stats.eventos}`);
    console.log(`DARs criadas:         ${stats.dars}`);
    console.log(`Vínculos criados:     ${stats.links}`);
    console.log(`Eventos atualizados:  ${stats.atualizados}`);

  } catch (err) {
    console.error('✗ Erro geral:', err);
    try { await dbRun(db, 'ROLLBACK'); } catch {}
    process.exit(1);
  } finally {
    db.close();
  }
})();
