// scripts/ajustar_eventos_55_22.js
process.env.TZ = 'America/Maceio';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB = process.env.SQLITE_STORAGE || path.resolve(__dirname, '../sistemacipt.db');

// ======== Parâmetros do ajuste ========
const HOJE = new Date().toISOString().slice(0,10);      // 'YYYY-MM-DD'
const PAGO_DATA = HOJE;                                  // data_pagamento p/ 55 e parcela paga do 22
const VALOR_PARCELA = 1247.50;
const VENC_RESTANTE = '2025-10-16';                      // parcela em aberto do evento 22
const CREATED_BY = 'ADMIN:AJUSTE';
const CLIENTE_DOC = '17361388000159';                    // 17.361.388/0001-59 normalizado
// =====================================

const db = new sqlite3.Database(DB);
const all = (sql, p=[]) => new Promise((res, rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));
const get =  (sql, p=[]) => new Promise((res, rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const run =  (sql, p=[]) => new Promise((res, rej)=>db.run(sql,p,function(e){ e?rej(e):res(this); }));

async function tableHasColumn(table, col){
  const cols = await all(`PRAGMA table_info(${table})`);
  return cols.some(c => c.name === col);
}
async function fkColumn(fromTable, targetTable){
  const rows = await all(`PRAGMA foreign_key_list('${fromTable}')`);
  const row = rows.find(r => r.table?.toLowerCase() === targetTable.toLowerCase());
  // se não achar, retornos padrão comuns
  return row ? row.from : (targetTable.toLowerCase()==='dars' ? 'dar_id' : 'evento_id');
}

async function darsDoEvento(eventoId, darFkCol, evFkCol){
  return await all(`
    SELECT d.*
      FROM dars d
      JOIN "DARs_Eventos" de ON de."${darFkCol}" = d.id
     WHERE de."${evFkCol}" = ? 
     ORDER BY d.id ASC
  `, [eventoId]);
}

(async()=>{
  try {
    console.log('[START] Ajustando eventos 55 (quitado) e 22 (parcial) …');

    // ===== Descobrir colunas/recursos =====
    const darFkCol = await fkColumn('DARs_Eventos','dars');
    const evFkCol  = await fkColumn('DARs_Eventos','Eventos');
    const has = {
      created_at: await tableHasColumn('dars','created_at'),
      created_by: await tableHasColumn('dars','created_by'),
      origem:     await tableHasColumn('dars','origem'),
      data_emissao: await tableHasColumn('dars','data_emissao'),
      data_pagamento: await tableHasColumn('dars','data_pagamento'),
      data_vencimento: await tableHasColumn('dars','data_vencimento'),
      mes_referencia: await tableHasColumn('dars','mes_referencia'),
      ano_referencia: await tableHasColumn('dars','ano_referencia'),
      permissionario_id: await tableHasColumn('dars','permissionario_id')
    };

    await run('BEGIN');

    // ===== EVENTO 55: tudo pago =====
    const dars55 = await darsDoEvento(55, darFkCol, evFkCol);
    if (dars55.length === 0) {
      console.warn('[WARN] Evento 55 sem DARs vinculadas. Nenhuma atualização aplicada.');
    } else {
      const ids = dars55.map(d => d.id);
      let setPagoSql = `UPDATE dars SET status='Pago'`;
      if (has.data_pagamento) setPagoSql += `, data_pagamento=?`;
      setPagoSql += ` WHERE id IN (${ids.map(()=>'?').join(',')})`;
      const params = has.data_pagamento ? [PAGO_DATA, ...ids] : [...ids];
      await run(setPagoSql, params);
      console.log(`[OK] Evento 55: ${ids.length} DAR(s) marcadas como Pago.`);
    }

    // ===== EVENTO 22: 1247,50 pago + 1247,50 em aberto (16/10/2025) =====
    let dars22 = await darsDoEvento(22, darFkCol, evFkCol);

    // Se não houver DARs, não dá para criar com 100% de certeza do schema (permissionario_id pode ser NOT NULL).
    // Estratégia: se houver ao menos 1 DAR, usamos ela como "modelo" para criar a que falta.
    if (dars22.length === 0) {
      console.warn('[WARN] Evento 22 sem DARs vinculadas. Não vou criar do zero por segurança (permissionario_id pode ser NOT NULL).');
    } else {
      // Garante pelo menos 2 DARs: a primeira (paga) e a segunda (restante)
      if (dars22.length === 1) {
        const modelo = dars22[0];
        // Tenta criar a 2a DAR usando o mesmo permissionario_id/competência, quando existirem.
        const fields = ['valor','status','numero_documento'];
        const vals   = [VALOR_PARCELA,'Emitido', `EVENTO-22-RESTANTE-${Date.now()}`];

        if (has.data_vencimento){ fields.push('data_vencimento'); vals.push(VENC_RESTANTE); }
        if (has.mes_referencia){ fields.push('mes_referencia'); vals.push(modelo.mes_referencia??null); }
        if (has.ano_referencia){ fields.push('ano_referencia'); vals.push(modelo.ano_referencia??null); }
        if (has.permissionario_id){ fields.push('permissionario_id'); vals.push(modelo.permissionario_id??null); }
        if (has.created_at){ fields.push('created_at'); vals.push(new Date().toISOString().slice(0,19).replace('T',' ')); }
        if (has.created_by){ fields.push('created_by'); vals.push(CREATED_BY); }
        if (has.origem){ fields.push('origem'); vals.push('Evento'); }
        if (has.data_emissao){ fields.push('data_emissao'); vals.push(null); }

        const placeholders = fields.map(()=>'?').join(',');
        const ins = await run(`INSERT INTO dars (${fields.join(',')}) VALUES (${placeholders})`, vals);
        const novoDarId = ins.lastID;

        await run(`INSERT INTO "DARs_Eventos" ("${darFkCol}","${evFkCol}") VALUES (?,?)`, [novoDarId, 22]);
        console.log(`[OK] Evento 22: criada DAR restante id=${novoDarId} (R$ ${VALOR_PARCELA.toFixed(2)}, venc ${VENC_RESTANTE}).`);

        dars22 = await darsDoEvento(22, darFkCol, evFkCol);
      }

      // Agora garantimos 2 DARs: usamos a mais antiga como "paga" e a mais nova como "restante"
      const [parcela1, parcela2] = [dars22[0], dars22[dars22.length-1]];

      // Parcela 1 → Pago 1247,50
      {
        const params = [];
        let sql = `UPDATE dars SET valor=?, status='Pago'`;
        params.push(VALOR_PARCELA);
        if (has.data_pagamento){ sql+=`, data_pagamento=?`; params.push(PAGO_DATA); }
        if (has.data_emissao && !parcela1.data_emissao){ sql+=`, data_emissao=COALESCE(data_emissao, datetime('now','localtime'))`; }
        sql += ` WHERE id=?`;
        params.push(parcela1.id);
        await run(sql, params);
      }

      // Parcela 2 → Emitido 1247,50 com venc 16/10/2025
      {
        const params = [VALOR_PARCELA, parcela2.id];
        let sql = `UPDATE dars SET valor=?, status='Emitido'`;
        if (has.data_vencimento){ sql+=`, data_vencimento='${VENC_RESTANTE}'`; }
        await run(sql + ` WHERE id=?`, params);
      }

      console.log(`[OK] Evento 22: atualizado para 2 parcelas (Pago R$ ${VALOR_PARCELA.toFixed(2)} + Emitido R$ ${VALOR_PARCELA.toFixed(2)} venc ${VENC_RESTANTE}).`);
    }

    await run('COMMIT');

    // ===== Relatórios rápidos =====
    const resumo55 = await all(`
      SELECT d.id, d.valor, d.status, d.data_pagamento
        FROM dars d JOIN "DARs_Eventos" de ON de."${darFkCol}"=d.id
       WHERE de."${evFkCol}"=55
       ORDER BY d.id ASC
    `);
    const resumo22 = await all(`
      SELECT d.id, d.valor, d.status, d.data_vencimento, d.data_pagamento
        FROM dars d JOIN "DARs_Eventos" de ON de."${darFkCol}"=d.id
       WHERE de."${evFkCol}"=22
       ORDER BY d.id ASC
    `);

    console.log('\n[RESUMO 55]', resumo55);
    console.log('[RESUMO 22]', resumo22);
    console.log('\n[OK] Ajustes concluídos.');
  } catch (e) {
    try { await run('ROLLBACK'); } catch(_) {}
    console.error('[ERRO]', e.message);
  } finally {
    db.close();
  }
})();
