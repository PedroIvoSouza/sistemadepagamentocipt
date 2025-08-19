// src/api/botRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const botAuthMiddleware = require('../middleware/botAuthMiddleware');

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

// --- helpers ---
const digits = (s = '') => String(s).replace(/\D/g, '');
const last11 = (s = '') => {
  const d = digits(s);
  return d.length > 11 ? d.slice(-11) : d;
};

// Limpeza de telefone dentro do SQL (SQLite não tem regex)
const PHONE_SQL_CLEAN = `
REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.telefone,''), '+',''), '(',''), ')',''), '-',''), ' ','')
`;

// Detecta se existe a coluna telefone_cobranca
let hasTelCobrancaCache = null;
function detectTelCobranca() {
  return new Promise((resolve) => {
    if (hasTelCobrancaCache !== null) return resolve(hasTelCobrancaCache);
    db.all(`PRAGMA table_info(permissionarios)`, [], (err, rows = []) => {
      if (err) { hasTelCobrancaCache = false; return resolve(false); }
      hasTelCobrancaCache = rows.some(r => (r.name || '').toLowerCase() === 'telefone_cobranca');
      resolve(hasTelCobrancaCache);
    });
  });
}

// =====================================================================
// GET /api/bot/dars?msisdn=5582XXXXXXXXX
//  -> retorna { ok, permissionario, dars: { vigente, vencidas[] } }
// =====================================================================
router.get('/dars', botAuthMiddleware, async (req, res) => {
  try {
    const msisdn = String(req.query.msisdn || '').trim();
    if (!msisdn) return res.status(400).json({ error: 'Parâmetro msisdn é obrigatório.' });

    const wantedFull = digits(msisdn);
    const wanted11 = last11(msisdn);
    const hasCobr = await detectTelCobranca();

    // Buscamos todos e comparamos em JS para tolerar formatos
    const cols = hasCobr
      ? `id, nome_empresa, telefone, telefone_cobranca`
      : `id, nome_empresa, telefone`;

    db.all(`SELECT ${cols} FROM permissionarios`, [], (e, rows = []) => {
      if (e) {
        console.error('[BOT][dars] erro SELECT permissionarios:', e.message);
        return res.status(500).json({ error: 'Erro ao consultar permissionários.' });
      }

      let found = null;
      for (const r of rows) {
        const cand = [digits(r.telefone || '')];
        if (hasCobr) cand.push(digits(r.telefone_cobranca || ''));
        if (cand.some(t => !!t && (t === wantedFull || t === wanted11 || last11(t) === wanted11))) {
          found = { id: r.id, nome_empresa: r.nome_empresa };
          break;
        }
      }

      if (!found) {
        return res.status(404).json({ error: 'Telefone não associado a nenhum permissionário.' });
      }

      const sqlVencidas = `
        SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
          FROM dars
         WHERE permissionario_id = ?
           AND status = 'Pendente'
           AND DATE(data_vencimento) < DATE('now')
         ORDER BY DATE(data_vencimento) ASC, id ASC
      `;
      const sqlVigente = `
        SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
          FROM dars
         WHERE permissionario_id = ?
           AND status = 'Pendente'
           AND DATE(data_vencimento) >= DATE('now')
         ORDER BY DATE(data_vencimento) ASC, id ASC
         LIMIT 1
      `;

      db.all(sqlVencidas, [found.id], (e1, vencidas = []) => {
        if (e1) {
          console.error('[BOT][dars] erro SELECT vencidas:', e1.message);
          return res.status(500).json({ error: 'Erro ao consultar DARs vencidas.' });
        }
        db.get(sqlVigente, [found.id], (e2, vigenteRow) => {
          if (e2) {
            console.error('[BOT][dars] erro SELECT vigente:', e2.message);
            return res.status(500).json({ error: 'Erro ao consultar DAR vigente.' });
          }
          const vigente = vigenteRow || null;
          return res.json({
            ok: true,
            permissionario: found,
            dars: { vigente, vencidas }
          });
        });
      });
    });
  } catch (err) {
    console.error('[BOT][dars] erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

// =====================================================================
// GET /api/bot/dars/:darId/pdf?msisdn=55XXXXXXXXXXX
//  -> retorna/redirect do PDF se o DAR pertencer ao telefone informado
// =====================================================================
router.get('/dars/:darId/pdf', botAuthMiddleware, (req, res) => {
  const darId = Number(req.params.darId);
  const msisdn = digits(req.query.msisdn);

  if (!darId || !msisdn) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  const alt11 = msisdn.startsWith('55') ? msisdn.slice(2) : msisdn;

  const sql = `
    SELECT d.id AS dar_id, d.pdf_url, d.permissionario_id
      FROM dars d
      JOIN permissionarios p ON p.id = d.permissionario_id
     WHERE d.id = ?
       AND ${PHONE_SQL_CLEAN} IN (?, ?)
     LIMIT 1
  `;

  db.get(sql, [darId, msisdn, alt11], (err, row) => {
    if (err) {
      console.error('[BOT][PDF] ERRO SQL:', err.message);
      return res.status(500).json({ error: 'Erro interno.' });
    }
    if (!row) {
      return res.status(404).json({ error: 'DAR não encontrada para este telefone.' });
    }
    if (!row.pdf_url) {
      return res.status(404).json({ error: 'DAR ainda não possui PDF gerado.' });
    }

    // Se for URL absoluta (GCS/S3/etc), redireciona
    if (/^https?:\/\//i.test(row.pdf_url)) {
      return res.redirect(row.pdf_url);
    }

    // Caminho relativo dentro de /public
    const abs = path.join(__dirname, '..', '..', 'public', row.pdf_url);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  });
});

module.exports = router;
