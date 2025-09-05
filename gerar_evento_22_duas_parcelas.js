// public/gerar_evento_22_duas_parcelas.js
process.env.TZ = 'America/Fortaleza';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB = process.env.SQLITE_STORAGE || path.resolve(__dirname, '../sistemacipt.db');

// ======== Parâmetros ========
const EVENTO_ID = 22;
const CLIENTE_NOME = 'CLAUDEMIR DOS SANTOS SILVA';
const CLIENTE_DOC  = '17361388000159';        // 17.361.388/0001-59 normalizado
const PARCELA_VAL  = 1247.50;
const VENC_RESTANTE = '2025-10-16';
const COMP_MES = 10;
const COMP_ANO = 2025;
const CREATED_BY = 'ADMIN:GERACAO-E22';
// ============================

const db = new sqlite3.Database(DB);
const all = (sql,p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));
const get =  (sql,p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const run =  (sql,p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){ e?rej(e):res(this); }));

async function tableHasColumn(table, col) {
  const cols = await all(`PRAGMA table_info(${table})`);
  return cols.some(c => c.name === col);
}
async function fkColumn(fromTable, targetName) {
  const rows = await all(`PRAGMA foreign_key_list('${fromTable}')`);
  const row = rows.find(r => (r.table||'').toLowerCase() === targetName.toLowerCase());
  return row ? row.from : (targetName.toLowerCase()==='dars' ? 'dar_id' : 'evento_id');
}

(async () => {
  try {
    console.log('[START] Gerando 2 DARs para evento 22 (1 paga + 1 emitida)…');

    const has = {
      created_at: await tableHasColumn('dars','created_at'),
      created_by: await tableHasColumn('dars','created_by'),
      origem: await tableHasColumn('dars','origem'),
      data_emissao: await tableHasColumn('dars','data_emissao'),
      data_pagamento: await tableHasColumn('dars','data_pagamento'),
      data_vencimento: await tableHasColumn('dars','data_vencimento'),
      mes_referencia: await tableHasColumn('dars','mes_referencia'),
      ano_referencia: await tableHasColumn('dars','ano_referencia'),
      permissionario_id: await tableHasColumn('dars','permissionario_id'),
    };
    const darFkCol = await fkColumn('DARs_Eventos','dars');
    const evFkCol  = await fkColumn('DARs_Eventos','Eventos');

    // 0) Garante permissionário pelo CNPJ
    let perm = await get(`
      SELECT id, nome_empresa, cnpj
        FROM permissionarios
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(cnpj,'.',''),'-',''),'/',''),' ','') = ?`,
       [CLIENTE_DOC]
    );
    if (!perm) {
      console.log('[INFO] Permissionário não existe. Criando…');
      const cols = ['nome_empresa','cnpj'];
      const vals = [CLIENTE_NOME, CLIENTE_DOC];
      if (await tableHasColumn('permissionarios','created_at')) {
        cols.push('created_at'); vals.push(new Date().toISOString().slice(0,19).replace('T',' '));
      }
      const ins = await run(`INSERT INTO permissionarios (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`, vals);
      perm = await get(`SELECT id, nome_empresa, cnpj FROM permissionarios WHERE id=?`, [ins.lastID]);
      console.log('[OK] Permissionário criado: id=', perm.id);
    } else {
      console.log('[OK] Permissionário encontrado: id=', perm.id, 'nome=', perm.nome_empresa);
    }

    await run('BEGIN');

    // 1) Se já existir algo do evento 22, vamos só completar o que faltar
    const existentes = await all(`
      SELECT d.id, d.valor, d.status, d.data_vencimento, d.data_pagamento
        FROM dars d
        JOIN "DARs_Eventos" de ON de."${darFkCol}" = d.id
       WHERE de."${evFkCol}" = ?
       ORDER BY d.id ASC
    `,[EVENTO_ID]);

    const falta = Math.max(0, 2 - existentes.length);

    // 2) Criar DARs que faltam
    for (let i=0; i<falta; i++) {
      const isParcela2 = (existentes.length + i === 1); // a 2ª criada será a "restante"
      const fields = [];
      const vals = [];

      if (has.permissionario_id){ fields.push('permissionario_id'); vals.push(perm.id); }
      if (has.mes_referencia){ fields.push('mes_referencia'); vals.push(COMP_MES); }
      if (has.ano_referencia){ fields.push('ano_referencia'); vals.push(COMP_ANO); }
      if (has.data_vencimento){ fields.push('data_vencimento'); vals.push(isParcela2 ? VENC_RESTANTE : null); }

      fields.push('valor'); vals.push(PARCELA_VAL);
      fields.push('status'); vals.push(isParcela2 ? 'Emitido' : 'Pago');

      fields.push('numero_documento'); vals.push(`EVENTO-22-PARCELA-${isParcela2?2:1}-${Date.now()}`);

      if (has.created_at){ fields.push('created_at'); vals.push(new Date().toISOString().slice(0,19).replace('T',' ')); }
      if (has.created_by){ fields.push('created_by'); vals.push(CREATED_BY); }
      if (has.origem){ fields.push('origem'); vals.push('Evento'); }
      if (has.data_emissao){ fields.push('data_emissao'); vals.push(isParcela2 ? null : new Date().toISOString().slice(0,19).replace('T',' ')); }
      if (has.data_pagamento && !isParcela2){ fields.push('data_pagamento'); vals.push(new Date().toISOString().slice(0,10)); }

      const placeholders = fields.map(()=>'?').join(',');
      const ins = await run(`INSERT INTO dars (${fields.join(',')}) VALUES (${placeholders})`, vals);
      const novoId = ins.lastID;
      await run(`INSERT INTO "DARs_Eventos" ("${darFkCol}","${evFkCol}") VALUES (?,?)`, [novoId, EVENTO_ID]);
      existentes.push(await get(`SELECT * FROM dars WHERE id=?`, [novoId]));
      console.log(`[OK] Criada DAR ${novoId} (${isParcela2?'Emitido venc '+VENC_RESTANTE:'Pago hoje'}) e vinculada ao evento 22.`);
    }

    // 3) Normaliza os status/valores conforme a regra solicitada
    const p1 = existentes[0];           // Paga
    const p2 = existentes[existentes.length-1]; // Restante emitida

    // Parcela 1 -> Pago 1247,50 (com data_pagamento hoje)
    {
      let sql = `UPDATE dars SET valor=?, status='Pago'`;
      const params = [PARCELA_VAL];
      if (has.data_pagamento){ sql+=`, data_pagamento=?`; params.push(new Date().toISOString().slice(0,10)); }
      if (has.data_emissao && !p1.data_emissao){ sql+=`, data_emissao=COALESCE(data_emissao, datetime('now','localtime'))`; }
      sql += ` WHERE id=?`; params.push(p1.id);
      await run(sql, params);
    }

    // Parcela 2 -> Emitido 1247,50 com venc 16/10/2025
    {
      let sql = `UPDATE dars SET valor=?, status='Emitido'`;
      const params = [PARCELA_VAL];
      if (has.data_vencimento){ sql+=`, data_vencimento=?`; params.push(VENC_RESTANTE); }
      sql += ` WHERE id=?`; params.push(p2.id);
      await run(sql, params);
    }

    await run('COMMIT');

    const resumo22 = await all(`
      SELECT d.id, d.valor, d.status, d.data_vencimento, d.data_pagamento, d.numero_documento
        FROM dars d JOIN "DARs_Eventos" de ON de."${darFkCol}"=d.id
       WHERE de."${evFkCol}"=?
       ORDER BY d.id ASC
    `,[EVENTO_ID]);
    console.log('\n[RESUMO 22]', resumo22);
    console.log('\n[OK] Evento 22 pronto: 1 parcela Paga + 1 parcela Emitida (16/10/2025).');
  } catch (e) {
    try { await run('ROLLBACK'); } catch(_) {}
    console.error('[ERRO]', e.message);
  } finally {
    db.close();
  }
})();
