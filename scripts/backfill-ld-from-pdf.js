mkdir -p scripts
cat > scripts/backfill-ld-from-pdf.js <<'JS'
#!/usr/bin/env node
/**
 * Backfill de linha_digitavel/codigo_barras em lote.
 * - Tenta a partir do codigo_barras (44→LD, 48→LD de arrecadação)
 * - Se não tiver, extrai do PDF (base64 / dataURL / arquivo local em uploads/public)
 * - Atualiza dars.linha_digitavel e dars.codigo_barras quando possível
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const pdfParse = require('pdf-parse');

// ----------------- Helpers de dígitos
const onlyDigits = (s='') => String(s || '').replace(/\D/g, '');

// 48 (arrecadação) -> 44 (removendo o último DV de cada bloco de 12)
function linha48ToCodigo44(ld48) {
  const d = onlyDigits(ld48);
  if (d.length !== 48 || d[0] !== '8') return null;
  const b1 = d.slice(0, 12), b2 = d.slice(12, 24), b3 = d.slice(24, 36), b4 = d.slice(36, 48);
  return b1.slice(0, 11) + b2.slice(0, 11) + b3.slice(0, 11) + b4.slice(0, 11);
}

// 47 (boleto) -> 44 (layout FEBRABAN)
function linha47ToCodigo44(ld47) {
  const d = onlyDigits(ld47);
  if (d.length !== 47) return null;
  const c1 = d.slice(0, 9); /* const c1dv = d.slice(9,10); */
  const c2 = d.slice(10, 20); /* const c2dv = d.slice(20,21); */
  const c3 = d.slice(21, 31); /* const c3dv = d.slice(31,32); */
  const dvGeral = d.slice(32,33);
  const fatorValor = d.slice(33,47);
  const bancoMoeda = c1.slice(0,4);
  const campoLivre = c1.slice(4,9) + c2 + c3;
  return bancoMoeda + dvGeral + fatorValor + campoLivre;
}

// Seu util original (44 -> LD; 48 de arrecadação já é LD)
function codigoBarrasParaLinhaDigitavel44(codigo='') {
  const digits = String(codigo).replace(/\D/g, '');
  if (digits.length !== 44) return '';
  const bloco1 = digits.slice(0, 4) + digits.slice(19, 24);
  const bloco2 = digits.slice(24, 34);
  const bloco3 = digits.slice(34, 44);
  const bloco4 = digits[4];
  const bloco5 = digits.slice(5, 19);
  const mod10 = str => {
    let soma = 0;
    let peso = 2;
    for (let i = str.length - 1; i >= 0; i--) {
      const n = parseInt(str[i], 10) * peso;
      soma += Math.floor(n / 10) + (n % 10);
      peso = peso === 2 ? 1 : 2;
    }
    const dig = (10 - (soma % 10)) % 10;
    return String(dig);
  };
  const campo1 = bloco1 + mod10(bloco1);
  const campo2 = bloco2 + mod10(bloco2);
  const campo3 = bloco3 + mod10(bloco3);
  return `${campo1}${campo2}${campo3}${bloco4}${bloco5}`;
}

// Extrai LD do conteúdo textual do PDF (47 ou 48)
function extrairLDDeTexto(text) {
  const txt = (text || '').replace(/[^\d\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Arrecadação: 11d DV 11d DV 11d DV 11d DV  -> total 48 com espaços
  const m48 = txt.match(/\b\d{11}\s\d\s\d{11}\s\d\s\d{11}\s\d\s\d{11}\s\d\b/);
  if (m48) return onlyDigits(m48[0]);

  // Boleto: 47 (regex permissivo)
  const m47 = txt.match(/\b\d{5}\s\d\s\d{5}\s\d\s\d{5}\s\d\s\d{6}\s\d{14}\b/);
  if (m47) return onlyDigits(m47[0]);

  return null;
}

async function extrairLDDePdfBase64(pdfBase64) {
  if (!pdfBase64) return { ld: null, cb: null };

  const base64 = String(pdfBase64).replace(/^data:application\/pdf;base64,/i, '');
  const buf = Buffer.from(base64, 'base64');
  const parsed = await pdfParse(buf);
  const ld = extrairLDDeTexto(parsed.text);
  if (!ld) return { ld: null, cb: null };

  let cb = null;
  if (ld.length === 48 && ld[0] === '8') cb = linha48ToCodigo44(ld);
  if (ld.length === 47) cb = linha47ToCodigo44(ld);

  return { ld, cb };
}

async function extrairLDDeArquivoLocal(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const parsed = await pdfParse(buf);
    const ld = extrairLDDeTexto(parsed.text);
    if (!ld) return { ld: null, cb: null };

    let cb = null;
    if (ld.length === 48 && ld[0] === '8') cb = linha48ToCodigo44(ld);
    if (ld.length === 47) cb = linha47ToCodigo44(ld);

    return { ld, cb };
  } catch {
    return { ld: null, cb: null };
  }
}

(async () => {
  // DB path
  const dbPath = process.env.SQLITE_PATH || path.resolve(__dirname, '..', 'sistemacipt.db');
  const db = new sqlite3.Database(dbPath);
  const qAll = (sql, p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r||[])));
  const qRun = (sql, p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){ e?rej(e):res(this); }));

  // Diretórios possíveis para PDF relativo (mesma lógica do servidor)
  const uploadsDir = process.env.UPLOADS_DIR || path.resolve(__dirname, '..', 'uploads');
  const publicDir  = path.resolve(__dirname, '..', 'public');

  // Seleciona candidatos com LD ausente/errada
  const rows = await qAll(`
    SELECT id, status, codigo_barras, linha_digitavel, pdf_url
      FROM dars
     WHERE (linha_digitavel IS NULL OR length(replace(linha_digitavel, '\\n','')) NOT IN (47,48))
  `);

  console.log('[INFO] Registros-alvo:', rows.length);
  let ok=0, skip=0, err=0;

  for (const r of rows) {
    try {
      let ld = onlyDigits(r.linha_digitavel || '');
      let cb = onlyDigits(r.codigo_barras || '');
      const pdf = r.pdf_url || '';

      // 1) Tenta a partir do codigo_barras
      if (!ld) {
        if (cb && (cb.length === 48 || cb.length === 44)) {
          if (cb.length === 48 && cb[0] === '8') {
            ld = cb; // arrecadação já é LD
          } else if (cb.length === 44) {
            ld = codigoBarrasParaLinhaDigitavel44(cb) || '';
          }
        }
      }

      // 2) Se ainda não tem, usar PDF (base64/dataURL ou arquivo local)
      if (!ld) {
        if (/^JVBER|^data:application\/pdf;base64,/i.test(pdf)) {
          const x = await extrairLDDePdfBase64(pdf);
          if (x.ld) ld = x.ld;
          if (x.cb) cb = onlyDigits(x.cb);
        } else if (pdf && !/^https?:\/\//i.test(pdf)) {
          // caminho relativo -> uploads/public
          const rel = String(pdf).replace(/^\/+/, '');
          const tryPaths = [path.join(uploadsDir, rel), path.join(publicDir, rel)];
          const found = tryPaths.find(p => fs.existsSync(p));
          if (found) {
            const x = await extrairLDDeArquivoLocal(found);
            if (x.ld) ld = x.ld;
            if (x.cb) cb = onlyDigits(x.cb);
          }
        }
      }

      // 3) Se temos LD de arrecadação e ainda não temos CB, derive
      if (ld && !cb && ld.length === 48 && ld[0] === '8') {
        cb = linha48ToCodigo44(ld) || '';
      }

      // 4) Se temos CB 44 e ainda não temos LD, derive
      if (cb && cb.length === 44 && !ld) {
        ld = codigoBarrasParaLinhaDigitavel44(cb) || '';
      }

      // 5) Persistir se achou algo
      if (ld) {
        await qRun(
          `UPDATE dars
              SET linha_digitavel = ?,
                  codigo_barras   = COALESCE(?, codigo_barras)
            WHERE id = ?`,
          [ld, cb || null, r.id]
        );
        console.log(`[OK] id=${r.id} ld=${ld.length} cb=${cb ? cb.length : 0}`);
        ok++;
      } else {
        console.log(`[SKIP] id=${r.id} sem LD detectável`);
        skip++;
      }

    } catch (e) {
      console.log(`[ERR] id=${r.id} ${e.message || e}`);
      err++;
    }
  }

  console.log(`[DONE] ok=${ok} skip=${skip} err=${err}`);
  db.close();
})();
JS
