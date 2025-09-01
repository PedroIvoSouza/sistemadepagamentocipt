require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { emitirGuiaSefaz } = require('../src/services/sefazService');

const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

const db = new sqlite3.Database(DB_PATH);
const getAll = (s,p=[])=>new Promise((res,rej)=>db.all(s,p,(e,r)=>e?rej(e):res(r)));
const run = (s,p=[])=>new Promise((res,rej)=>db.run(s,p,function(e){e?rej(e):res(this)}));

function parseHolidaySet() {
  const raw = (process.env.FERIADOS_AL || '').trim();
  return new Set(raw ? raw.split(',').map(s => s.trim()) : []);
}
function isWeekend(d) { const w = d.getUTCDay(); return w===0 || w===6; }
function nextBusinessDay(iso, feriados) {
  let d = new Date(iso+'T00:00:00Z');
  for (let i=0;i<7;i++) {
    const s = d.toISOString().slice(0,10);
    if (!isWeekend(d) && !feriados.has(s)) return s;
    d.setUTCDate(d.getUTCDate()+1);
  }
  return iso;
}

(async ()=>{
  try {
    const feriados = parseHolidaySet();

    const pend = await getAll(`
      SELECT d.id, d.valor, d.data_vencimento,
             e.id AS id_evento,
             ce.nome_razao_social AS cliente_nome, ce.documento AS cliente_doc
        FROM dars d
        JOIN DARs_Eventos de ON de.id_dar = d.id
        JOIN Eventos e ON e.id = de.id_evento
        JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
       WHERE (d.numero_documento IS NULL OR d.numero_documento = '')
         AND (d.status IS NULL OR d.status = '' OR d.status = 'Pendente')
       ORDER BY d.id ASC
    `);

    if (!pend.length) {
      console.log('Nada pendente para emitir.');
      process.exit(0);
    }

    console.log('Encontradas pendentes:', pend.map(x=>x.id).join(', '));

    let emitted = 0, failed = 0;
    for (const p of pend) {
      let [ano, mes] = String(p.data_vencimento).split('-').map(Number);
      const contrib = { nome: p.cliente_nome, documento: p.cliente_doc };

      // tenta emitir; se for fds/feriado, empurra para próximo dia útil e sincroniza no DB
      let useDate = p.data_vencimento;
      let ok = false, lastErr = null;

      for (let tent=0; tent<5; tent++) {
        try {
          const resp = await emitirGuiaSefaz(contrib, {
            id: p.id,
            valor: p.valor,
            data_vencimento: useDate,
            mes_referencia: mes,
            ano_referencia: ano
          });

          const numero    = resp?.guiaNumero || resp?.numero || resp?.referencia || null;
          const codBarras = resp?.codigoBarras || resp?.codigo_barras || null;
          const pdfUrl    = resp?.pdf || resp?.pdf_url || resp?.link_pdf || null;

          await run(`UPDATE dars
                        SET numero_documento = COALESCE(?, numero_documento),
                            codigo_barras   = COALESCE(?, codigo_barras),
                            pdf_url         = COALESCE(?, pdf_url),
                            status          = CASE WHEN status='Pendente' OR status IS NULL OR status='' THEN 'Emitido' ELSE status END,
                            data_emissao    = COALESCE(data_emissao, date('now'))
                      WHERE id = ?`, [numero, codBarras, pdfUrl, p.id]);

          if (useDate !== p.data_vencimento) {
            await run(`UPDATE dars SET data_vencimento=? WHERE id=?`, [useDate, p.id]);
            await run(`UPDATE DARs_Eventos SET data_vencimento=? WHERE id_dar=?`, [useDate, p.id]);
          }

          console.log('[OK] Emitido', { id: p.id, numero });
          emitted++; ok = true; break;
        } catch (e) {
          lastErr = e?.message || String(e);
          if (/fim de semana|feriado/i.test(lastErr)) {
            useDate = nextBusinessDay(useDate, feriados);
            // atualiza mes/ano se virar de mês/ano ao pular feriado
            [ano, mes] = useDate.split('-').map(Number);
            continue;
          }
          break;
        }
      }

      if (!ok) {
        console.log('[FAIL]', { id: p.id, err: lastErr });
        failed++;
      }
    }

    console.log('--- RESUMO ---', { emitted, failed });
  } catch (e) {
    console.error('Erro geral:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();
