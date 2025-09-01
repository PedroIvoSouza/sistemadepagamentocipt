/**
 * Vincular DARs de uma planilha de eventos a Eventos já existentes no banco,
 * gerando as parcelas (dars) e a tabela de vínculo DARs_Eventos.
 *
 * Recursos:
 *  - Detecção de "PAGO" na célula da parcela (cria já como Pago e define data_pagamento)
 *  - Normalização e matching robusto do numero_processo (remove E:, pontos, espaços, barras)
 *  - Sugestões por nome+ano quando não encontra o evento
 *
 * Uso:
 *   npm i xlsx
 *   node vincular_dars_eventos.js --excel "/caminho/Eventos PAGOS CIPT.xlsx" --db "/var/www/api/sistemacipt.db"
 *
 * Flags:
 *   --excel           caminho para a planilha .xlsx
 *   --db              caminho do SQLite (default: ./sistemacipt.db)
 *   --dry-run         não altera o banco; apenas mostra as operações
 *   --marcar-pago     (opcional) marca TODAS as DARs do evento como Pago (além da detecção por parcela)
 *   --pag-data=hoje|venc   (default: 'venc') controla a data_pagamento quando marcamos Pago
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');

// ----------------- Helpers gerais -----------------
function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}
function brMoneyToFloat(v) {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  // Extrai o primeiro número padrão BR "1.234,56" dentro da string
  const m = s.match(/(\d{1,3}(?:\.\d{3})*|\d+)(,\d{2})?/);
  if (!m) return NaN;
  s = m[0].replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}
function parsePagoFlag(cellValue) {
  // Considera "pago" se houver a palavra, ignorando acentuação e caixa
  const txt = String(cellValue || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /(^|\s)pago(\s|$)/i.test(txt);
}
function parseDatePtBR(s) {
  if (!s) return null;
  const txt = String(s).trim();
  // dd/mm/yyyy
  let m = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    const y = m[3].length === 2 ? ('20' + m[3]) : m[3];
    return `${y}-${mo}-${d}`;
  }
  // yyyy-mm-dd (com ou sem hora)
  m = txt.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // fallback simples: dayfirst se parece dd/mm/yy
  const parts = txt.split(/[T\s]/)[0].split(/[\/\-]/);
  if (parts.length === 3) {
    let [a, b, c] = parts;
    if (a.length <= 2 && b.length <= 2) {
      const y = c.length === 2 ? ('20' + c) : c;
      return [y, b.padStart(2, '0'), a.padStart(2, '0')].join('-');
    }
  }
  return null;
}
function ymdToYearMonth(iso) {
  const [y, m] = String(iso).split('-');
  return { ano: parseInt(y, 10), mes: parseInt(m, 10) };
}
function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

// ----------------- Normalização & busca de Evento -----------------
function normProc(s) {
  const up = String(s || '').toUpperCase().trim();
  const noDotsSpaces = up.replace(/[.\s]/g, '');
  const noPrefix = noDotsSpaces.replace(/^E:/, '');
  const noSlash = noPrefix.replace(/\//g, '');
  const digitsOnly = up.replace(/\D/g, '');
  const m = up.match(/(\d{3,})\/(\d{4})/); // pega segmento final + ano (ex.: 0000000592/2024)
  const segAno = m ? (m[1] + '/' + m[2]) : null;
  return { rawUpper: up, noPrefix, noSlash, digitsOnly, segAno };
}

async function findEventoByNumeroProcesso(dbGet, numero) {
  const { rawUpper, noPrefix, noSlash, digitsOnly, segAno } = normProc(numero);

  // 1) match direto (UPPER) e normalizado
  let row = await dbGet(
    `SELECT id, id_cliente, status, numero_processo, COALESCE(nome_evento, '') AS nome
       FROM Eventos
      WHERE UPPER(numero_processo) = ?
         OR REPLACE(REPLACE(REPLACE(UPPER(numero_processo),'E:',''),'.',''),' ','') = ?
         OR REPLACE(REPLACE(REPLACE(REPLACE(UPPER(numero_processo),'E:',''),'.',''),' ','') , '/','') = ?
      LIMIT 1`,
    [rawUpper, noPrefix, noSlash]
  );
  if (row) return row;

  // 2) Fallbacks com LIKE (cautela)
  const likes = [];
  if (segAno) likes.push('%' + segAno + '%');
  if (digitsOnly.length >= 6) likes.push('%' + digitsOnly.slice(-6) + '%'); // últimos 6 dígitos como pista

  for (const pat of likes) {
    row = await dbGet(
      `SELECT id, id_cliente, status, numero_processo, COALESCE(nome_evento, '') AS nome
         FROM Eventos
        WHERE UPPER(numero_processo) LIKE ?
           OR REPLACE(REPLACE(UPPER(numero_processo),'.',''),' ','') LIKE ?
        LIMIT 1`,
      [pat, pat]
    );
    if (row) return row;
  }
  return null;
}

// ----------------- Programa principal -----------------
(async () => {
  const EXCEL = argValue('--excel');
  const DBPATH = argValue('--db', './sistemacipt.db');
  const DRY = argFlag('--dry-run');
  const MARK_PAID_ALL = argFlag('--marcar-pago');
  const PAG_DATA = (argValue('--pag-data', 'venc') || 'venc').toLowerCase(); // 'venc' ou 'hoje'

  if (!EXCEL || !fs.existsSync(EXCEL)) {
    console.error('Erro: informe --excel com o caminho do arquivo .xlsx');
    process.exit(1);
  }
  if (!fs.existsSync(DBPATH)) {
    console.error(`Erro: banco não encontrado em ${DBPATH}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(EXCEL);
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Mapeia colunas (tolerando variações)
  function findCol(possibles) {
    const cols = Object.keys(rows[0] || {});
    for (const p of possibles) {
      const col = cols.find(c => c.trim().toLowerCase() === p.trim().toLowerCase());
      if (col) return col;
    }
    for (const p of possibles) {
      const col = cols.find(c => c.trim().toLowerCase().startsWith(p.trim().toLowerCase()));
      if (col) return col;
    }
    return null;
  }
  const headers = Object.keys(rows[0] || {});
  const COL_EMPRESA = findCol(['EMPRESA']);
  const COL_DOC     = findCol(['CNPJ/CPF', 'CNPJ/CPF ']);
  const COL_PROC    = findCol(['N º DO PROCESSO','Nº DO PROCESSO','NUMERO DO PROCESSO','N° DO PROCESSO']);
  const COL_PAR1    = findCol(['1ª PARCELA','1ª PARCELA ']);
  const COL_DUE1    = findCol(['DATA LIMITE PARA PAGAMENTO','DATA LIMITE PARA PAGAMENTO ']);

  // pode haver 2 colunas "DATA LIMITE PARA PAGAMENTO"
  const dueCandidates = headers.filter(h => h.toLowerCase().startsWith('data limite para pagamento'));
  const COL_DUE2      = dueCandidates.length > 1 ? dueCandidates[1] : null;
  const COL_PAR2      = findCol(['2ª PARCELA']);

  // Conexão SQLite
  const db = new sqlite3.Database(DBPATH);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    if (DRY) { console.log('[DRY-RUN][SQL]', sql, params); return resolve({ changes: 0, lastID: 0 }); }
    db.run(sql, params, function (err) { if (err) return reject(err); resolve(this); });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) return reject(err); resolve(row); });
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) return reject(err); resolve(rows); });
  });

  let createdDARs = 0, linkedDARs = 0, skipped = 0, markedPaid = 0, notFound = 0, alreadyLinked = 0;

  for (const r of rows) {
    const empresa     = String(r[COL_EMPRESA] || '').trim();
    const docDigits   = onlyDigits(r[COL_DOC] || '');
    const numProcesso = String(r[COL_PROC] || '').trim();
    if (!numProcesso) {
      console.warn('[AVISO] Sem número de processo — pulando:', empresa);
      skipped++;
      continue;
    }

    const ev = await findEventoByNumeroProcesso(get, numProcesso);
    if (!ev) {
      console.warn('[NÃO ENCONTRADO] Evento não localizado por numero_processo:', numProcesso, '-', empresa);
      // Sugestões (até 5) por nome e ano (se extraído)
      const yr = (String(numProcesso).match(/(\d{4})/) || [])[1];
      try {
        const whereAno = yr ? ` AND numero_processo LIKE '%/${yr}%' ` : '';
        const cand = await all(
          `SELECT id, nome_evento AS nome, numero_processo
             FROM Eventos
            WHERE UPPER(nome_evento) LIKE ? ${whereAno}
            LIMIT 5`,
          ['%' + String(empresa || '').toUpperCase() + '%']
        );
        if (cand && cand.length) {
          console.warn('  Sugestões:');
          for (const c of cand) console.warn(`   - [${c.id}] ${c.nome} :: ${c.numero_processo}`);
        }
      } catch (e) { /* ignore */ }
      notFound++;
      continue;
    }

    // PARCELA 1
    const v1Raw = r[COL_PAR1];
    const isPago1 = parsePagoFlag(v1Raw);
    const v1 = brMoneyToFloat(v1Raw);
    const due1 = parseDatePtBR(r[COL_DUE1]);

    // PARCELA 2
    const v2Raw = r[COL_PAR2];
    const isPago2 = parsePagoFlag(v2Raw);
    const v2 = brMoneyToFloat(v2Raw);
    const due2 = COL_DUE2 ? parseDatePtBR(r[COL_DUE2]) : null;

    const parcelas = [];
    if (Number.isFinite(v1) && v1 > 0 && due1) parcelas.push({ n: 1, valor: v1, venc: due1, pago: isPago1 });
    if (Number.isFinite(v2) && v2 > 0 && due2) parcelas.push({ n: 2, valor: v2, venc: due2, pago: isPago2 });

    for (const p of parcelas) {
      // Já existe vínculo igual?
      const existing = await get(
        `SELECT d.id AS dar_id, d.status
           FROM DARs_Eventos de
           JOIN dars d ON d.id = de.id_dar
          WHERE de.id_evento = ?
            AND de.numero_parcela = ?
            AND ABS(d.valor - ?) < 0.01
            AND date(d.data_vencimento) = date(?)`,
        [ev.id, p.n, p.valor, p.venc]
      );

      if (existing?.dar_id) {
        // Se já existe e precisa marcar pago:
        if ((p.pago || MARK_PAID_ALL) && existing.status !== 'Pago') {
          const dataPg = (PAG_DATA === 'hoje') ? new Date().toISOString().slice(0,10) : p.venc;
          const upd = await run(
            `UPDATE dars SET status='Pago', data_pagamento=COALESCE(data_pagamento, ?) WHERE id=?`,
            [dataPg, existing.dar_id]
          );
          markedPaid += upd.changes || 0;
        } else {
          alreadyLinked++;
        }
        continue;
      }

      // Criar DAR nova
      const { ano, mes } = ymdToYearMonth(p.venc);
      const initialStatus = (p.pago || MARK_PAID_ALL) ? 'Pago' : 'Pendente';
      const dataPg = (initialStatus === 'Pago')
        ? ((PAG_DATA === 'hoje') ? new Date().toISOString().slice(0,10) : p.venc)
        : null;

      const darStmt = await run(
        `INSERT INTO dars (valor, data_vencimento, status, mes_referencia, ano_referencia, permissionario_id, tipo_permissionario, data_pagamento)
         VALUES (?, ?, ?, ?, ?, NULL, 'Evento', ?)`,
        [p.valor, p.venc, initialStatus, mes, ano, dataPg]
      );
      const darId = darStmt.lastID;

      await run(
        `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
         VALUES (?, ?, ?, ?, ?)`,
        [ev.id, darId, p.n, p.valor, p.venc]
      );

      createdDARs++;
      linkedDARs++;
    }
  }

  db.close();

  console.log('--- RESUMO ---');
  console.log('DARs criadas:          ', createdDARs);
  console.log('Vínculos criados:      ', linkedDARs);
  console.log('Já vinculadas (mantidas)', alreadyLinked);
  console.log('Eventos não achados:   ', notFound);
  console.log('Linhas puladas:        ', skipped);
  console.log('DARs marcadas "Pago":  ', markedPaid);
})();
