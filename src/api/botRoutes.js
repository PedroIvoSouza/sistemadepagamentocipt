// src/api/botRoutes.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const router = express.Router();

// Abre a base só para leitura (evita lock de escrita)
const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
db.configure('busyTimeout', 5000); // espera até 5s se houver lock

const digits = (v='') => String(v).replace(/\D/g, '');

// Segurança simples: header compartilhado
router.use((req, res, next) => {
  const headerKey = req.get('x-bot-key');
  if (!process.env.BOT_SHARED_KEY || headerKey !== process.env.BOT_SHARED_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

/**
 * GET /api/bot/dars?msisdn=5582XXXXXXXXX
 * - msisdn: telefone WhatsApp do usuário (E.164, ou qualquer formato com dígitos)
 * Retorna: permissionário + DAR vigente + DARs vencidas (pendentes).
 */
router.get('/dars', (req, res) => {
  const msisdn = digits(req.query.msisdn || '');
  if (!msisdn) return res.status(400).json({ error: 'Parâmetro msisdn é obrigatório.' });

  // Fazemos match por sufixo (últimos 11 dígitos), para tolerar “+55”, parênteses, etc.
  const last11 = msisdn.slice(-11);
  const likeParam = `%${last11}`;

  // Observação: se você tiver outra coluna de telefone (ex.: telefone_cobranca), inclua no WHERE com OR.
  const sqlPerm = `
    SELECT id, nome_empresa, telefone
      FROM permissionarios
     WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(telefone,''),'(',''),')',''),'-',''),' ',''),'.','')
           LIKE ?
     ORDER BY id
     LIMIT 1
  `;

  db.get(sqlPerm, [likeParam], (err, perm) => {
    if (err) return res.status(500).json({ error: 'Erro de banco', detail: err.message });
    if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado para este telefone.' });

    const sqlDars = `
      SELECT id, permissionario_id, mes_referencia, ano_referencia, valor,
             data_vencimento, status, linha_digitavel, pdf_url
        FROM dars
       WHERE permissionario_id = ?
       ORDER BY date(data_vencimento) ASC, id ASC
    `;
    db.all(sqlDars, [perm.id], (err2, rows=[]) => {
      if (err2) return res.status(500).json({ error: 'Erro ao buscar DARs', detail: err2.message });

      const hoje = new Date().toISOString().slice(0,10);

      const pendentes = rows.filter(r => r.status === 'Pendente');
      const vigentes = pendentes.filter(r => (r.data_vencimento || '') >= hoje);
      const vencidas = pendentes.filter(r => (r.data_vencimento || '') < hoje);

      // Pega a primeira “a vencer” como vigente (se existir)
      const vigente = vigentes.length ? vigentes[0] : null;

      const base = (process.env.ADMIN_PUBLIC_BASE || '').replace(/\/$/, '');
      function fullUrl(u) {
        if (!u) return null;
        if (/^https?:\/\//i.test(u)) return u;        // já é absoluta
        return base ? `${base}${u.startsWith('/') ? '' : '/'}${u}` : u; // prefixa domínio
      }

      const mapDar = (d) => ({
        id: d.id,
        mes_referencia: d.mes_referencia,
        ano_referencia: d.ano_referencia,
        valor: d.valor,
        data_vencimento: d.data_vencimento,
        status: d.status,
        linha_digitavel: d.linha_digitavel || null,
        pdf_url: fullUrl(d.pdf_url)
      });

      res.json({
        permissionario: {
          id: perm.id,
          nome_empresa: perm.nome_empresa,
          telefone: perm.telefone
        },
        vigente: vigente ? mapDar(vigente) : null,
        vencidas: vencidas.map(mapDar)
      });
    });
  });
});

module.exports = router;
