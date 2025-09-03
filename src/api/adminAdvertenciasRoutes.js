const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');

const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const db = require('../database/db');
const { gerarAdvertenciaPdfEIndexar } = require('../services/advertenciaPdfService');
const termoClausulas = require('../constants/termoClausulas');

const router = express.Router();
router.use(adminAuthMiddleware);

router.get('/advertencias/clausulas', (_req, res) => {
  res.json(termoClausulas);
});

// ========= SQLite helpers =========
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve(this);
  });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

async function ensureSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS advertencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento_id INTEGER,
      fatos TEXT,
      clausulas TEXT,
      multa REAL,
      gera_multa INTEGER,
      inapto INTEGER,
      inapto_ate TEXT,
      prazo_recurso TEXT,
      status TEXT,
      token TEXT,
      pdf_url TEXT,
      pdf_public_url TEXT,
      created_at TEXT,
      resolved_at TEXT,
      outcome TEXT
    )`);
  const cols = await dbAll(`PRAGMA table_info('advertencias')`);
  if (!cols.some(c => c.name === 'inapto_ate')) {
    await dbRun(`ALTER TABLE advertencias ADD COLUMN inapto_ate TEXT`);
  }
}

async function sendAdvertenciaEmail(to, link) {
  if (!to) return;
  try {
    const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = (process.env.SMTP_PASS || process.env.EMAIL_PASS || '').replace(/\s+/g, '');
    if (!host || !user || !pass) {
      console.warn('[MAIL] Configuração SMTP ausente, modo dry-run.');
      console.log(`[MAIL][DRY-RUN] advertência → ${to} link: ${link}`);
      return;
    }
    const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || user,
      to,
      subject: 'Advertência emitida',
      text: `Uma advertência foi emitida. Consulte: ${link}`,
    });
    console.log(`[MAIL] advertência enviada → ${to}`);
  } catch (err) {
    console.error('[MAIL][ERRO] advertência →', err.message);
  }
}

async function gerarDarAdvertencia(db, advertenciaId, valor) {
  console.log(`[ADVERTENCIA] gerar DAR advertenciaId=${advertenciaId} valor=${valor}`);
  // Implementação real deve gerar DAR de multa para a advertência
}

/* ===========================================================
   POST /api/admin/eventos/:id/advertencias
   =========================================================== */
router.post('/eventos/:id/advertencias', async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const { fatos, clausulas, multa, gera_multa, inapto, inapto_ate, prazo_recurso } = req.body || {};
    if (!fatos || !Array.isArray(clausulas) || clausulas.length === 0 || multa == null || typeof inapto !== 'boolean' || !prazo_recurso) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    const evento = await dbGet(`SELECT e.id, e.nome_evento, ce.id AS cliente_id, ce.nome_razao_social AS cliente_nome, ce.email, ce.documento
                                  FROM Eventos e JOIN Clientes_Eventos ce ON ce.id = e.id_cliente WHERE e.id = ?`, [id]);
    if (!evento) return res.status(404).json({ error: 'Evento não encontrado.' });

    const clausulasDetalhadas = (clausulas || [])
      .map((c) => {
        if (typeof c === "string" || typeof c === "number") {
          const num = String(c);
          return { numero: num, texto: termoClausulas[num] };
        }
        if (c && typeof c === "object") {
          const num = String(c.numero || c.num || c.id || "");
          const texto = c.texto || termoClausulas[num];
          return { numero: num, texto };
        }
        return null;
      })
      .filter((c) => c && c.texto);

    if (!clausulasDetalhadas.length) {
      return res.status(400).json({ error: 'Cláusulas inválidas.' });
    }

    const resumoSancao = gera_multa ? `Multa de R$ ${Number(multa).toFixed(2)}` : (inapto ? 'Inaptidão do cliente' : 'Advertência');
    const { filePath, token } = await gerarAdvertenciaPdfEIndexar({
      evento: { id: evento.id, nome_evento: evento.nome_evento },
      cliente: { id: evento.cliente_id, nome_razao_social: evento.cliente_nome, documento: evento.documento },
      dosFatos: fatos,
      clausulas: clausulasDetalhadas,
      resumoSancao,
      token: null,
    });
    const pdfUrl = filePath;
    const pdfPublicUrl = `/documentos/${path.basename(filePath)}`;
    const now = new Date().toISOString();
    const stmt = await dbRun(
      `INSERT INTO advertencias (evento_id,fatos,clausulas,multa,gera_multa,inapto,inapto_ate,prazo_recurso,status,token,pdf_url,pdf_public_url,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [evento.id, fatos, JSON.stringify(clausulasDetalhadas), Number(multa), gera_multa ? 1 : 0, inapto ? 1 : 0, inapto_ate || null, prazo_recurso, 'emitida', token, pdfUrl, pdfPublicUrl, now]
    );

    const advertenciaId = stmt.lastID;

    if (inapto && inapto_ate) {
      try {
        await dbRun(`UPDATE Clientes_Eventos SET inapto_ate = ?, status_cliente = 'inapto' WHERE id = ?`, [inapto_ate, evento.cliente_id]);
      } catch (err) {
        console.error('[ADVERTENCIA] erro ao atualizar cliente:', err.message);
      }
    }

    if (gera_multa) {
      try { await gerarDarAdvertencia(db, advertenciaId, multa); } catch (err) { console.error('[ADVERTENCIA] DAR erro:', err.message); }
    }

    const link = (process.env.BASE_URL || '') + pdfPublicUrl;
    await sendAdvertenciaEmail(evento.email, link);

    res.status(201).json({ id: advertenciaId, token, pdf_url: pdfPublicUrl });
  } catch (err) {
    console.error('[ADVERTENCIA][POST] erro:', err.message);
    res.status(500).json({ error: 'Erro ao criar advertência.' });
  }
});

/* ===========================================================
   GET /api/admin/advertencias
   =========================================================== */
router.get('/advertencias', async (req, res) => {
  try {
    await ensureSchema();
    const { status, cliente } = req.query || {};
    const where = [];
    const params = [];
    if (status) { where.push('a.status = ?'); params.push(status); }
    if (cliente) { where.push('ce.nome_razao_social LIKE ?'); params.push(`%${cliente}%`); }
    const sql = `SELECT a.*, ce.nome_razao_social AS cliente_nome
                 FROM advertencias a
                 LEFT JOIN Eventos e ON e.id = a.evento_id
                 LEFT JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY a.created_at DESC`;
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[ADVERTENCIA][GET] erro:', err.message);
    res.status(500).json({ error: 'Erro ao listar advertências.' });
  }
});

/* ===========================================================
   PUT /api/admin/advertencias/:id/resolver
   =========================================================== */
router.put('/advertencias/:id/resolver', async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const { resultado } = req.body || {};
    if (!resultado) return res.status(400).json({ error: 'Resultado é obrigatório.' });

    const advInfo = await dbGet(`SELECT prazo_recurso, evento_id FROM advertencias WHERE id = ?`, [id]);
    if (!advInfo) return res.status(404).json({ error: 'Advertência não encontrada.' });
    if (advInfo.prazo_recurso && new Date() > new Date(advInfo.prazo_recurso)) {
      return res.status(400).json({ error: 'Prazo de recurso expirado.' });
    }

    const status = resultado === 'aceito' ? 'recurso_aceito' : 'recurso_negado';
    const resolvedAt = new Date().toISOString();
    await dbRun(`UPDATE advertencias SET status = ?, outcome = ?, resolved_at = ?, multa = CASE WHEN ?='aceito' THEN 0 ELSE multa END, inapto = CASE WHEN ?='aceito' THEN 0 ELSE inapto END, inapto_ate = CASE WHEN ?='aceito' THEN NULL ELSE inapto_ate END WHERE id = ?`,
      [status, resultado, resolvedAt, resultado, resultado, resultado, id]);

    if (resultado === 'aceito' && advInfo.evento_id) {
      try {
        const ev = await dbGet(`SELECT id_cliente FROM Eventos WHERE id = ?`, [advInfo.evento_id]);
        if (ev && ev.id_cliente) {
          await dbRun(`UPDATE Clientes_Eventos SET inapto_ate = NULL, status_cliente = NULL WHERE id = ?`, [ev.id_cliente]);
        }
      } catch (err) {
        console.error('[ADVERTENCIA] erro ao limpar cliente:', err.message);
      }
    }

    res.json({ message: 'Advertência atualizada.' });
  } catch (err) {
    console.error('[ADVERTENCIA][PUT] erro:', err.message);
    res.status(500).json({ error: 'Erro ao resolver advertência.' });
  }
});

module.exports = router;
