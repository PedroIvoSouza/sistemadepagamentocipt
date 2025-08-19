// src/api/botRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const botAuth = require('../middleware/botAuthMiddleware');

const router = express.Router();
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

const fs   = require('fs');


// --- cole abaixo dos requires existentes no botRoutes.js ---
const fs   = require('fs');
const path = require('path');

// Normaliza número para só dígitos
const digits = (s) => String(s || '').replace(/\D/g, '');

// Remove +, (), -, espaço dentro do SQL (SQLite não tem regex)
const PHONE_SQL_CLEAN = `
REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.telefone,''), '+',''), '(',''), ')',''), '-',''), ' ','')
`;

// GET /api/bot/dars/:darId/pdf?msisdn=55XXXXXXXXXXX
router.get('/dars/:darId/pdf', botAuthMiddleware, (req, res) => {
  const darId  = Number(req.params.darId);
  const msisdn = digits(req.query.msisdn);

  if (!darId || !msisdn) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  // Aceita variações do número (com/sem 55)
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

    // Se estiver armazenando link absoluto (ex.: GCS/S3), redireciona:
    if (/^https?:\/\//i.test(row.pdf_url)) {
      return res.redirect(row.pdf_url);
    }

    // Caso seja caminho relativo dentro de /public
    const abs = path.join(__dirname, '..', '..', 'public', row.pdf_url);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dar_${row.dar_id}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  });
});


// util
const digits = (s='') => String(s).replace(/\D/g, '');
const last11 = (s='') => {
  const d = digits(s);
  return d.length > 11 ? d.slice(-11) : d;
};

// cache de schema (pra saber se existe telefone_cobranca)
let hasTelCobranca = null;
function detectTelCobranca() {
  return new Promise((resolve) => {
    if (hasTelCobranca !== null) return resolve(hasTelCobranca);
    db.all(`PRAGMA table_info(permissionarios)`, [], (err, rows=[]) => {
      if (err) { hasTelCobranca = false; return resolve(false); }
      hasTelCobranca = rows.some(r => (r.name || '').toLowerCase() === 'telefone_cobranca');
      resolve(hasTelCobranca);
    });
  });
}

// GET /api/bot/dars?msisdn=5582...
router.get('/dars', botAuth, async (req, res) => {
  try {
    const msisdn = String(req.query.msisdn || '').trim();
    if (!msisdn) return res.status(400).json({ error: 'Parâmetro msisdn é obrigatório.' });

    const wantedFull = digits(msisdn);
    const wanted11   = last11(msisdn);

    const hasCobr = await detectTelCobranca();

    // Busca permissionário por telefone (principal e, se existir, telefone_cobranca)
    const cols = hasCobr
      ? `id, nome_empresa, telefone, telefone_cobranca`
      : `id, nome_empresa, telefone`;

    db.all(`SELECT ${cols} FROM permissionarios`, [], (e, rows=[]) => {
      if (e) {
        console.error('[BOT][dars] erro SELECT permissionarios:', e.message);
        return res.status(500).json({ error: 'Erro ao consultar permissionários.' });
      }

      let found = null;
      for (const r of rows) {
        const cand = [
          digits(r.telefone || ''),
        ];
        if (hasCobr) cand.push(digits(r.telefone_cobranca || ''));

        // compare contra MSISDN (com +55) e contra últimos 11 dígitos
        if (cand.some(t => !!t && (t === wantedFull || t === wanted11 || last11(t) === wanted11))) {
          found = { id: r.id, nome_empresa: r.nome_empresa };
          break;
        }
      }

      if (!found) {
        return res.status(404).json({ error: 'Telefone não associado a nenhum permissionário.' });
      }

      // DARs vencidas (pendentes com vencimento no passado)
      const sqlVencidas = `
        SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
          FROM dars
         WHERE permissionario_id = ?
           AND status = 'Pendente'
           AND DATE(data_vencimento) < DATE('now')
         ORDER BY DATE(data_vencimento) ASC, id ASC
      `;
      // DAR vigente (próxima pendente não vencida)
      const sqlVigente = `
        SELECT id, valor, data_vencimento, status, numero_documento, linha_digitavel, pdf_url
          FROM dars
         WHERE permissionario_id = ?
           AND status = 'Pendente'
           AND DATE(data_vencimento) >= DATE('now')
         ORDER BY DATE(data_vencimento) ASC, id ASC
         LIMIT 1
      `;

      db.all(sqlVencidas, [found.id], (e1, vencidas=[]) => {
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
            dars: {
              vigente,
              vencidas
            }
          });
        });
      });
    });
  } catch (err) {
    console.error('[BOT][dars] erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

// src/api/botRoutes.js (adicione abaixo do GET /dars)
router.get('/dars/:darId/pdf', botAuthMiddleware, async (req, res) => {
  const darId = Number(req.params.darId);
  const msisdn = String((req.query.msisdn || '')).replace(/\D/g, '');

  if (!darId || !msisdn) return res.status(400).json({ error: 'Parâmetros inválidos.' });

  const dar = await getAsync(`
    SELECT d.id, d.permissionario_id, d.pdf_url
      FROM dars d
      JOIN permissionarios p ON p.id = d.permissionario_id
     WHERE d.id = ?
       AND REPLACE(IFNULL(p.telefone,''), '\\D', '') IN (?, ?, ?, ?)
  `, [
    darId,
    msisdn,                      // e.g. 5582999992881
    msisdn.replace(/^55/, ''),   // e.g. 82999992881
    msisdn.slice(-11),           // e.g. 82999992881 (fallback)
    msisdn.slice(-9)             // e.g. 99992881 (fallback emergência)
  ]);

  if (!dar) return res.status(404).json({ error: 'DAR não encontrada para este telefone.' });
  if (!dar.pdf_url) return res.status(404).json({ error: 'DAR ainda não possui PDF gerado.' });

  const abs = path.join(__dirname, '..', '..', 'public', dar.pdf_url);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="dar_${dar.id}.pdf"`);
  fs.createReadStream(abs).pipe(res);
});


module.exports = router;
