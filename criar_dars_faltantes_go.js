// criar_dars_faltantes_go.js
// Uso:
//   node criar_dars_faltantes_go.js
//
// O que faz:
// - Localiza o permissionário da GO DESENVOLVIMENTO (CNPJ 21950824000100).
// - Calcula um valor base = média das DARs existentes desse CNPJ (se não houver, pede para informar).
// - Cria DARs faltantes marcadas como 'Vencida' para os meses:
//     2023-08, 2023-12, 2024-01..2024-12
// - Define data_vencimento = último dia útil do mês.
// - Não cria PDF/linha digitável/código de barras (campos permanecem nulos).
//
// Requisitos: sqlite3 já no projeto.

const sqlite3 = require('sqlite3').verbose();

const CNPJ_GO = '21950824000100'; // GO DESENVOLVIMENTO — só dígitos
const MESES_GO_FALTANTES = [
  { ano: 2023, mes: 8 },
  { ano: 2023, mes: 12 },
  // 2024-01 .. 2024-12
  ...Array.from({length:12}, (_,i)=>({ ano: 2024, mes: i+1 })),
];

const db = new sqlite3.Database('./sistemacipt.db');

function onlyDigits(s){ return (s||'').toString().replace(/\D+/g,''); }
function lastBusinessDayISO(year, month){ // month: 1..12
  const d = new Date(Date.UTC(year, month, 0)); // último dia do mês (JS usa 0 = último do mês anterior)
  // 0=domingo, 6=sábado
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2); // domingo -> sexta
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1); // sábado -> sexta
  // retorna em 'YYYY-MM-DD'
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const dd = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

function get(sql, params=[]){ return new Promise(res=>db.get(sql, params, (e,row)=>res(row||null))); }
function all(sql, params=[]){ return new Promise(res=>db.all(sql, params, (e,rows)=>res(rows||[]))); }
function run(sql, params=[]){ return new Promise(res=>db.run(sql, params, function(err){ res({err, changes:this?.changes, lastID:this?.lastID}); })); }

(async function main(){
  try{
    // 1) Achar permissionário
    const perm = await get(`
      SELECT id, nome_empresa, cnpj
      FROM permissionarios
      WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`,
      [CNPJ_GO]
    );
    if (!perm) {
      console.error('ERRO: permissionário GO DESENVOLVIMENTO não encontrado. Verifique o CNPJ no banco.');
      process.exit(1);
    }
    console.log(`GO DESENVOLVIMENTO → permissionario_id=${perm.id} (${perm.nome_empresa})`);

    // 2) Valor base = média das DARs existentes desse CNPJ (qualquer mês/ano)
    const avg = await get(`
      SELECT ROUND(AVG(d.valor), 2) AS media
      FROM dars d
      WHERE d.permissionario_id = ?`, [perm.id]);
    const valorBase = avg?.media;
    if (!valorBase) {
      console.error('ERRO: não há DARs prévias para calcular a média. Informe um valor base manualmente no script.');
      process.exit(1);
    }
    console.log(`Valor base estimado (média das existentes): R$ ${valorBase}`);

    // 3) Criar as DARs faltantes (se não existirem)
    let criadas = 0, puladas = 0;
    await run('BEGIN TRANSACTION');

    for (const {ano, mes} of MESES_GO_FALTANTES) {
      const ja = await get(`
        SELECT id FROM dars
        WHERE permissionario_id = ? AND ano_referencia = ? AND mes_referencia = ?`,
        [perm.id, ano, mes]
      );
      if (ja) { puladas++; continue; }

      const venc = lastBusinessDayISO(ano, mes); // último dia útil
      const sql = `
        INSERT INTO dars (
          permissionario_id, mes_referencia, ano_referencia,
          valor, data_vencimento, status, tipo_permissionario, numero_documento
        ) VALUES (?, ?, ?, ?, ?, 'Vencida', 'Permissionario', ?)
      `;
      const numeroDoc = `BACKFILL-${ano}${String(mes).padStart(2,'0')}-${CNPJ_GO.slice(-4)}`;
      const {err, lastID} = await run(sql, [perm.id, mes, ano, valorBase, venc, numeroDoc]);
      if (err) { console.error('ERRO ao inserir DAR', ano, mes, err.message); continue; }
      console.log(`CRIADA: dars.id=${lastID} ${ano}-${String(mes).padStart(2,'0')} valor=${valorBase} venc=${venc}`);
      criadas++;
    }

    await run('COMMIT');
    console.log(`\nResumo: Criadas=${criadas} | Puladas (já existiam)=${puladas}`);
    db.close();
  }catch(e){
    console.error('Falha:', e);
    await run('ROLLBACK');
    db.close();
    process.exit(1);
  }
})();
