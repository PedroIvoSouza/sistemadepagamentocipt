// scripts/importar_dars_eventos_desde_csv.js
// Uso:
//   node scripts/importar_dars_eventos_desde_csv.js ./dars_eventos_import.csv
//   node scripts/importar_dars_eventos_desde_csv.js ./dars_eventos_emitir.csv --emitir
//   node scripts/importar_dars_eventos_desde_csv.js ./dars_eventos_emitir.csv --emitir --usar-vigencia
//   node scripts/importar_dars_eventos_desde_csv.js ./dars_eventos_emitir.csv --emitir --venc-default=2025-09-10
//
// Sem --emitir: cria + vincula.
// Com --emitir: cria + vincula + emite as com acao=CRIAR+VINCULAR+EMITIR.

require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env')
});
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

const { parse } = require('csv-parse/sync');
const { emitirGuiaSefaz } = require('../src/services/sefazService');

const csvPath = path.resolve(process.argv[2] || './dars_eventos_import.csv');
const SHOULD_EMIT = process.argv.includes('--emitir');

function arg(name, def = '') {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const USAR_VIGENCIA = process.argv.includes('--usar-vigencia');
const VENC_DEFAULT = arg('venc-default', process.env.VENC_DEFAULT || ''); // ex: 2025-09-10

if (!fs.existsSync(csvPath)) {
  console.error('CSV não encontrado:', csvPath);
  process.exit(1);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

async function getEventoByIdOrProc(db, idEvento, procNorm) {
  if (idEvento) {
    const ev = await get(db, `
      SELECT e.id, e.nome_evento, e.id_cliente, ce.nome_razao_social AS cliente_nome, ce.documento AS cliente_doc,
             e.data_vigencia_final, e.datas_evento
        FROM Eventos e
        JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
       WHERE e.id = ?`, [idEvento]);
    if (ev) return ev;
  }
  if (!procNorm) return null;

  const cols = await all(db, `PRAGMA table_info(Eventos)`);
  const names = new Set(cols.map(c => c.name));

  const where = [];
  const args = [];
  if (names.has('numero_processo_termo')) { where.push('numero_processo_termo = ?'); args.push(procNorm); }
  if (names.has('numero_processo'))       { where.push('numero_processo = ?');       args.push(procNorm); }
  if (names.has('numero_oficio_sei'))     { where.push('numero_oficio_sei = ?');     args.push(procNorm); }

  if (!where.length) return null;

  const ev = await get(db, `
    SELECT e.id, e.nome_evento, e.id_cliente, ce.nome_razao_social AS cliente_nome, ce.documento AS cliente_doc,
           e.data_vigencia_final, e.datas_evento
      FROM Eventos e
      JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
     WHERE ${where.join(' OR ')}
     LIMIT 1`, args);
  return ev || null;
}

function pickVencimento(ev, vencCsv) {
  const v = String(vencCsv || '').trim();
  if (v) return v;
  if (USAR_VIGENCIA && ev?.data_vigencia_final) return String(ev.data_vigencia_final).slice(0, 10);
  if (USAR_VIGENCIA && ev?.datas_evento) {
    const ms = String(ev.datas_evento).match(/\d{4}-\d{2}-\d{2}/g);
    if (ms && ms.length) return ms.sort().slice(-1)[0];
  }
  if (VENC_DEFAULT) return VENC_DEFAULT;
  return '';
}

async function existeParcelaIgual(db, idEvento, parcela, vencISO, valor) {
  const row = await get(db, `
    SELECT d.id
      FROM DARs_Eventos de
      JOIN dars d ON d.id = de.id_dar
     WHERE de.id_evento = ?
       AND de.numero_parcela = ?
       AND de.data_vencimento = ?
       AND ROUND(de.valor_parcela * 100) = ROUND(? * 100)
     LIMIT 1`, [idEvento, parcela, vencISO, valor]);
  return !!row;
}

(async () => {
  const db = new sqlite3.Database(DB_PATH);
  await run(db, 'PRAGMA foreign_keys = ON;');

  // === detectar colunas da dars (evita erro de "no column named tipo_permissionario") ===
  const darsCols = await all(db, 'PRAGMA table_info(dars)');
  const hasTipoPerm = darsCols.some(c => c.name === 'tipo_permissionario');
  const hasDataEmissao = darsCols.some(c => c.name === 'data_emissao');

// Procura uma DAR já existente SEM vínculo para reusar (mesmo valor + vencimento).
async function pickExistingDar(db, valor, venc, hasTipoPerm) {
  // Tenta filtrar por 'Evento' se a coluna existir; senão, reusa qualquer DAR solta
  const baseSql = `
    SELECT d.id
      FROM dars d
      LEFT JOIN DARs_Eventos de ON de.id_dar = d.id
     WHERE de.id IS NULL
       AND ROUND(d.valor * 100) = ROUND(? * 100)
       AND d.data_vencimento = ?
  `;
  const sql = hasTipoPerm ? baseSql + ` AND COALESCE(d.tipo_permissionario,'') IN ('Evento','')` : baseSql;
  return await get(db, sql + ` ORDER BY d.id DESC LIMIT 1`, [valor, venc]);
}

  
  console.log('\n--- VERIFICANDO VARIÁVEIS DE AMBIENTE CARREGADAS ---');
  console.log('SEFAZ_MODE:', `[${process.env.SEFAZ_MODE || ''}]`);
  console.log('SEFAZ_TLS_INSECURE:', `[${process.env.SEFAZ_TLS_INSECURE || ''}]`);
  const tok = (process.env.SEFAZ_APP_TOKEN || '');
  console.log('SEFAZ_APP_TOKEN (primeiros 5 caracteres):', tok ? `[${tok.slice(0,5)}...]` : '[]');
  console.log('----------------------------------------------------\n');

  const csv = fs.readFileSync(csvPath, 'utf-8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

  let created = 0, linked = 0, emitted = 0, markedPaid = 0, skipped = 0;

  for (const r of rows) {
    try {
      const idEventoCsv = Number(r.id_evento || 0);
      const procNorm = String(r.processo_norm || '').trim();
      const parcela = Number(r.numero_parcela || 1);
      const valor = Number(r.valor_parcela);
      const vencCsv = String(r.data_vencimento || '').trim();
      const acao = String(r.acao || '').toUpperCase();
      const statusDesejado = String(r.status_desejado || 'Pendente');

      if (!valor || Number.isNaN(valor)) {
        console.warn('[SKIP] Valor inválido/ausente:', { idEventoCsv, procNorm, valor });
        skipped++;
        continue;
      }

      const evento = await getEventoByIdOrProc(db, idEventoCsv, procNorm);
      if (!evento) {
        console.warn(`[SKIP] Evento não encontrado (id=${idEventoCsv} proc=${procNorm || '-'})`);
        skipped++;
        continue;
      }

      const venc = pickVencimento(evento, vencCsv);
      if (!venc) {
        console.warn('[SKIP] Sem vencimento (e sem fallback); use --usar-vigencia ou --venc-default=YYYY-MM-DD', { idEvento: evento.id, procNorm });
        skipped++;
        continue;
      }

      const [ano, mes] = venc.split('-').map(n => Number(n));
      if (!ano || !mes) {
        console.warn('[SKIP] Vencimento inválido (esperado AAAA-MM-DD):', { venc, idEvento: evento.id });
        skipped++;
        continue;
      }

      if (await existeParcelaIgual(db, evento.id, parcela, venc, valor)) {
        console.log('[OK] Já existe parcela igual — pulando (idempotente):', { idEvento: evento.id, parcela, venc, valor });
        continue;
      }

      // monta colunas dinamicamente
      const darCols = ['valor','data_vencimento','status','mes_referencia','ano_referencia','permissionario_id'];
      const darVals = [valor, venc, 'Pendente', mes, ano, null];
      if (hasTipoPerm) {
        darCols.push('tipo_permissionario');
        darVals.push('Evento');
      }

// Tenta reusar uma DAR “solta” (criada no run anterior e nunca vinculada)
let darId;
const reuse = await pickExistingDar(db, valor, venc, hasTipoPerm);
if (reuse?.id) {
  darId = reuse.id;
  // garante marcação 'Evento' se a coluna existir
  if (hasTipoPerm) {
    await run(db, `UPDATE dars SET tipo_permissionario = COALESCE(tipo_permissionario, 'Evento') WHERE id = ?`, [darId]);
  }
} else {
  // cria DAR nova (emissão ajusta número/código depois)
  const darCols = ['valor','data_vencimento','status','mes_referencia','ano_referencia','permissionario_id'];
  const darVals = [valor, venc, 'Pendente', mes, ano, null];
  if (hasTipoPerm) {
    darCols.push('tipo_permissionario');
    darVals.push('Evento');
  }
  const darIns = await run(db,
    `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(()=>'?').join(',')})`,
    darVals
  );
  darId = darIns.lastID;
  created++;
}

      
      const darIns = await run(db,
        `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(()=>'?').join(',')})`,
        darVals
      );
      const darId = darIns.lastID;
      created++;

      await run(db, `
        INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
        VALUES (?,?,?,?,?)`,
        [darId, evento.id, parcela, valor, venc]
      );
      linked++;

      if (statusDesejado.toLowerCase().startsWith('pago') || acao.includes('MARCAR_PAGO')) {
        const hoje = new Date().toISOString().slice(0,10);
        await run(db, `UPDATE dars SET status='Pago', data_pagamento=? WHERE id=?`, [venc || hoje, darId]);
        markedPaid++;
      }

      if (SHOULD_EMIT && acao.includes('EMITIR')) {
        const contrib = { nome: evento.cliente_nome, documento: evento.cliente_doc };
        const guiaLike = { id: darId, valor, data_vencimento: venc, mes_referencia: mes, ano_referencia: ano };

        try {
          const resp = await emitirGuiaSefaz(contrib, guiaLike);
          const numero    = resp?.guiaNumero || resp?.numero || resp?.referencia || null;
          const codBarras = resp?.codigoBarras || resp?.codigo_barras || null;
          const pdfUrl    = resp?.pdf || resp?.pdf_url || resp?.link_pdf || null;

          await run(db, `
            UPDATE dars
               SET numero_documento = COALESCE(?, numero_documento),
                   codigo_barras   = COALESCE(?, codigo_barras),
                   pdf_url         = COALESCE(?, pdf_url)
             WHERE id = ?`,
            [numero, codBarras, pdfUrl, darId]
          );

          // se existir data_emissao e status ainda Pendente, marque como Emitido
          if (hasDataEmissao) {
            await run(db, `
              UPDATE dars
                 SET data_emissao = COALESCE(data_emissao, date('now')),
                     status = CASE WHEN status='Pendente' THEN 'Emitido' ELSE status END
               WHERE id = ?`, [darId]);
          }

          emitted++;
        } catch (e) {
          console.error(`[WARN] Falha ao emitir DAR ${darId} (evento ${evento.id}):`, e.message);
        }
      }
    } catch (e) {
      console.error('[ERRO] Linha com falha:', e.message);
      skipped++;
    }
  }

  console.log('--- RESULTADO ---');
  console.log({ created, linked, emitted, markedPaid, skipped });

  db.close();
})();
