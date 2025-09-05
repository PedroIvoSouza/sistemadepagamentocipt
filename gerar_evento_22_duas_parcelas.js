// public/gerar_evento_22_duas_parcelas.js
process.env.TZ = 'America/Fortaleza';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB = process.env.SQLITE_STORAGE || path.resolve(__dirname, '../sistemacipt.db');

// ===== Parâmetros =====
const EVENTO_ID = 22;
const PARCELA_VAL = 1247.50;
const VENC_RESTANTE = '2025-10-16'; // parcela 2
const CREATED_BY = 'ADMIN:GERACAO-E22';
// =====================

const db = new sqlite3.Database(DB);
const all = (sql,p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));
const get =  (sql,p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const run =  (sql,p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){ e?rej(e):res(this); }));

async function hasCol(table, col) {
  const cols = await all(`PRAGMA table_info(${table})`);
  return cols.some(c => c.name === col);
}

(async () => {
  try {
    console.log('[START] Gerando 2 DARs para o evento', EVENTO_ID);

    // Confere se o evento existe e pega o cliente
    const ev = await get(`
      SELECT e.id, e.id_cliente, c.nome_razao_social AS cliente_nome, c.documento AS cliente_doc
        FROM Eventos e
        JOIN Clientes_Eventos c ON c.id = e.id_cliente
       WHERE e.id = ?`, [EVENTO_ID]);
    if (!ev) throw new Error(`Evento ${EVENTO_ID} não encontrado.`);

    // Colunas opcionais em dars
    const has = {
      created_at:      await hasCol('dars','created_at'),
      created_by:      await hasCol('dars','created_by'),
      origem:          await hasCol('dars','origem'),
      data_emissao:    await hasCol('dars','data_emissao'),
      data_pagamento:  await hasCol('dars','data_pagamento'),
      data_vencimento: await hasCol('dars','data_vencimento'),
      mes_referencia:  await hasCol('dars','mes_referencia'),
      ano_referencia:  await hasCol('dars','ano_referencia'),
      numero_documento:await hasCol('dars','numero_documento'),
    };

    const hojeDate = new Date();
    const hoje = hojeDate.toISOString().slice(0,10); // YYYY-MM-DD
    const agora = new Date(Date.now() - hojeDate.getTimezoneOffset()*60000).toISOString().slice(0,19).replace('T',' ');

    await run('BEGIN');

    // 1) Cria PARCELA 1 (Pago hoje)
    const f1 = [];
    const v1 = [];
    f1.push('valor'); v1.push(PARCELA_VAL);
    f1.push('status'); v1.push('Pago');
    if (has.numero_documento){ f1.push('numero_documento'); v1.push(`E${EVENTO_ID}-PARC-1-${Date.now()}`); }
    if (has.data_pagamento)   { f1.push('data_pagamento');   v1.push(hoje); }
    if (has.data_emissao)     { f1.push('data_emissao');     v1.push(agora); }
    if (has.data_vencimento)  { f1.push('data_vencimento');  v1.push(hoje); } // opcional: vence hoje
    if (has.mes_referencia)   { f1.push('mes_referencia');   v1.push(10); }   // comp. exemplo
    if (has.ano_referencia)   { f1.push('ano_referencia');   v1.push(2025); }
    if (has.created_at)       { f1.push('created_at');       v1.push(agora); }
    if (has.created_by)       { f1.push('created_by');       v1.push(CREATED_BY); }
    if (has.origem)           { f1.push('origem');           v1.push('Evento'); }

    const p1 = await run(`INSERT INTO dars (${f1.join(',')}) VALUES (${f1.map(()=>'?').join(',')})`, v1);
    const dar1 = p1.lastID;

    // 2) Cria PARCELA 2 (Emitido, vencimento 16/10/2025)
    const f2 = [];
    const v2 = [];
    f2.push('valor'); v2.push(PARCELA_VAL);
    f2.push('status'); v2.push('Emitido');
    if (has.numero_documento){ f2.push('numero_documento'); v2.push(`E${EVENTO_ID}-PARC-2-${Date.now()}`); }
    if (has.data_vencimento)  { f2.push('data_vencimento'); v2.push(VENC_RESTANTE); }
    if (has.mes_referencia)   { f2.push('mes_referencia');  v2.push(10); }
    if (has.ano_referencia)   { f2.push('ano_referencia');  v2.push(2025); }
    if (has.created_at)       { f2.push('created_at');      v2.push(agora); }
    if (has.created_by)       { f2.push('created_by');      v2.push(CREATED_BY); }
    if (has.origem)           { f2.push('origem');          v2.push('Evento'); }

    const p2 = await run(`INSERT INTO dars (${f2.join(',')}) VALUES (${f2.map(()=>'?').join(',')})`, v2);
    const dar2 = p2.lastID;

    // 3) Vincula na DARs_Eventos (usa nomes do seu schema: id_evento, id_dar)
    await run(
      `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
       VALUES (?, ?, ?, ?, ?)`,
      [EVENTO_ID, dar1, 1, PARCELA_VAL, (has.data_vencimento ? hoje : VENC_RESTANTE)]
    );
    await run(
      `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
       VALUES (?, ?, ?, ?, ?)`,
      [EVENTO_ID, dar2, 2, PARCELA_VAL, VENC_RESTANTE]
    );

    // 4) Atualiza status do evento para "Pago Parcialmente"
    await run(`UPDATE Eventos SET status='Pago Parcialmente' WHERE id=?`, [EVENTO_ID]);

    await run('COMMIT');

    const resumo = await all(`
      SELECT d.id, d.valor, d.status, d.data_vencimento, d.data_pagamento, d.numero_documento
        FROM dars d
        JOIN DARs_Eventos de ON de.id_dar = d.id
       WHERE de.id_evento = ?
       ORDER BY de.numero_parcela ASC, d.id ASC
    `,[EVENTO_ID]);

    console.log(`[OK] Evento ${EVENTO_ID} do cliente ${ev.cliente_nome} (${ev.cliente_doc})`);
    console.log('[DARs]', resumo);
    console.log('[DONE] 1 parcela Paga + 1 parcela Emitida/venc', VENC_RESTANTE);
  } catch (e) {
    try { await run('ROLLBACK'); } catch(_) {}
    console.error('[ERRO]', e.message);
  } finally {
    db.close();
  }
})();
