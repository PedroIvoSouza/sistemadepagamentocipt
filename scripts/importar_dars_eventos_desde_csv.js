// scripts/importar_dars_eventos_desde_csv.js
// Uso:
//   node scripts/importar_dars_eventos_desde_csv.js ./dars_eventos_import.csv --emitir
//
// Sem --emitir: só cria + vincula; com --emitir: cria + vincula + emite as que tiverem acao=CRIAR+VINCULAR+EMITIR

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { parse } = require('csv-parse/sync');

const { emitirGuiaSefaz } = require('../src/services/sefazService');

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve('./sistemacipt.db');

const csvPath = path.resolve(process.argv[2] || './dars_eventos_import.csv');
const SHOULD_EMIT = process.argv.includes('--emitir');

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

(async () => {
  const db = new sqlite3.Database(DB_PATH);

  const csv = fs.readFileSync(csvPath, 'utf-8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

  let created = 0, linked = 0, emitted = 0, markedPaid = 0, skipped = 0;

  // checagens básicas
  await run(db, 'PRAGMA foreign_keys = ON;');

  for (const r of rows) {
    try {
      const idEvento = Number(r.id_evento);
      const parcela = Number(r.numero_parcela || 1);
      const valor = Number(r.valor_parcela);
      const venc = String(r.data_vencimento || '').trim();
      const acao = String(r.acao || '').toUpperCase();
      const statusDesejado = (r.status_desejado || 'Pendente');

      if (!idEvento || !valor || !venc) {
        console.warn('[SKIP] Linha incompleta:', { idEvento, valor, venc });
        skipped++;
        continue;
      }

      // garante evento e pega cliente
      const evento = await get(db, `
        SELECT e.id, e.nome_evento, e.id_cliente, ce.nome_razao_social AS cliente_nome, ce.documento AS cliente_doc
          FROM Eventos e
          JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
         WHERE e.id = ?`, [idEvento]);

      if (!evento) {
        console.warn(`[SKIP] Evento ${idEvento} não encontrado.`);
        skipped++;
        continue;
      }

      const [ano, mes] = venc.split('-').map(n => Number(n));
      const darCols = ['valor','data_vencimento','status','mes_referencia','ano_referencia','permissionario_id','tipo_permissionario'];
      const darVals = [valor, venc, 'Pendente', mes, ano, null, 'Evento'];

      // cria DAR base (a emissão preenche número/código depois)
      const darIns = await run(db,
        `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(()=>'?').join(',')})`,
        darVals
      );
      const darId = darIns.lastID;
      created++;

      // vincula na tabela de junção
      await run(db, `
        INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
        VALUES (?,?,?,?,?)`,
        [darId, idEvento, parcela, valor, venc]
      );
      linked++;

      // marcar como pago, se for o caso
      if (statusDesejado.toLowerCase().startsWith('pago') || acao.includes('MARCAR_PAGO')) {
        const hoje = new Date().toISOString().slice(0,10);
        await run(db, `UPDATE dars SET status='Pago', data_pagamento=? WHERE id=?`, [venc || hoje, darId]);
        markedPaid++;
      }

      // emitir se solicitado e se a linha pedir emissão
      if (SHOULD_EMIT && acao.includes('EMITIR')) {
        const contrib = {
          nome: evento.cliente_nome,
          documento: evento.cliente_doc
        };

        const guiaLike = {
          id: darId,
          valor: valor,
          data_vencimento: venc,
          mes_referencia: mes,
          ano_referencia: ano
        };

        try {
          const resp = await emitirGuiaSefaz(contrib, guiaLike);
          // tente mapear campos comuns de retorno
          const numero = resp?.guiaNumero || resp?.numero || resp?.referencia || null;
          const codBarras = resp?.codigoBarras || resp?.codigo_barras || null;
          const pdfUrl = resp?.pdf || resp?.pdf_url || resp?.link_pdf || null;

          await run(db, `
            UPDATE dars
               SET numero_documento = COALESCE(?, numero_documento),
                   codigo_barras   = COALESCE(?, codigo_barras),
                   pdf_url         = COALESCE(?, pdf_url),
                   status          = CASE WHEN status='Pendente' THEN 'Emitido' ELSE status END,
                   data_emissao    = COALESCE(data_emissao, date('now'))
             WHERE id = ?`,
            [numero, codBarras, pdfUrl, darId]
          );

          emitted++;
        } catch (e) {
          console.error(`[WARN] Falha ao emitir DAR ${darId} (evento ${idEvento}):`, e.message);
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
