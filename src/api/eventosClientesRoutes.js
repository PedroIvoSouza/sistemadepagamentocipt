// src/api/eventosClientesRoutes.js
// Normaliza/valida CPF/CNPJ e corrige POST (sem tipoNormalizado), PF/PJ coerente com CHECK('PF','PJ')

const express  = require('express');
const sqlite3  = require('sqlite3').verbose();
const bcrypt   = require('bcrypt');
const path     = require('path');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const { Parser } = require('json2csv');
const xlsx     = require('xlsx');

const { enviarEmailDefinirSenha } = require('../services/emailService');
const { fetchCnpjData }           = require('../services/cnpjLookupService');
const { fetchCepAddress }         = require('../services/cepLookupService');
const adminAuthMiddleware         = require('../middleware/adminAuthMiddleware');
const authMiddleware              = require('../middleware/authMiddleware');
const authorizeRole               = require('../middleware/roleMiddleware');

// === Serviços usados no Termo + Assinafy ===
const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');
const { uploadPdf } = require('../services/assinafyClient');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { imprimirTokenEmPdf } = require('../utils/token');
const { normalizeAssinafyStatus } = require('../services/assinafyUtils');
const { getDocument, pickBestArtifactUrl } = require('../services/assinafyService');

const adminRouter  = express.Router();
const publicRouter = express.Router();
const clientRouter = express.Router();

const dbPath = path.resolve(__dirname, '..', '..', 'sistemacipt.db');
const db = new sqlite3.Database(dbPath);

const SALT_ROUNDS = 10;

// Utils
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const isCpf  = d => !!d && d.length === 11;
const isCnpj = d => !!d && d.length === 14;

// PF/PJ para o CHECK da tabela (aceita entradas variadas e devolve 'PF' | 'PJ')
const normalizeTipoPessoa = (v = '') => {
  const s = String(v).trim().toUpperCase();
  if (['PF', 'FISICA', 'FÍSICA', 'PESSOA FISICA', 'PESSOA FÍSICA'].includes(s)) return 'PF';
  if (['PJ', 'JURIDICA', 'JURÍDICA', 'PESSOA JURIDICA', 'PESSOA JURÍDICA'].includes(s)) return 'PJ';
  return '';
};

// Helpers de DB (promessas)
const dbGet = (sql, p = []) => new Promise((resolve, reject) => {
  db.get(sql, p, (e, r) => e ? reject(e) : resolve(r));
});
const dbAll = (sql, p = []) => new Promise((resolve, reject) => {
  db.all(sql, p, (e, r) => e ? reject(e) : resolve(r));
});
const dbRun = (sql, p = []) => new Promise((resolve, reject) => {
  db.run(sql, p, function (e) { e ? reject(e) : resolve(this); });
});

/* ===================================================================
   ROTAS DO CLIENTE LOGADO (PORTAL DE EVENTOS) – exigem CLIENTE_EVENTO
   =================================================================== */
clientRouter.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO']));

/**
 * GET /api/portal/eventos/:id/termo/meta
 * Retorna metadados do termo do evento para o portal (URL pública do PDF, status, assinafy_id, etc.)
 */
clientRouter.get('/:id/termo/meta', async (req, res) => {
  try {
    const eventoId = req.params.id;
    // garante que existe registro em `documentos` (gera se necessário)
    let doc = await dbGet(`SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY created_at DESC, id DESC LIMIT 1`, [eventoId]);
    if (!doc || !doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
      await gerarTermoEventoPdfkitEIndexar(eventoId);
      doc = await dbGet(`SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY created_at DESC, id DESC LIMIT 1`, [eventoId]);
    }
    if (!doc || !doc.pdf_url) return res.status(404).json({ error: 'Termo não encontrado.' });

    // preferir a pública (que já apontamos para /public/documentos/...)
    const url = doc.pdf_public_url || null;

    let assinafy = null;
    if (doc.assinafy_id) {
      try {
        assinafy = await getDocument(doc.assinafy_id);
      } catch {}
    }

    const bestAssinado = doc.signed_pdf_public_url || (assinafy ? pickBestArtifactUrl(assinafy) : null);
    const raw = assinafy?.data?.status || assinafy?.status || doc.status;
    const status = normalizeAssinafyStatus(raw, !!bestAssinado);

    return res.json({
      ok: true,
      evento_id: eventoId,
      status,
      pdf_public_url: url,
      assinafy_id: doc.assinafy_id || null,
      signed_pdf_public_url: bestAssinado || null,
      signed_at: doc.signed_at || null
    });
  } catch (e) {
    console.error('[PORTAL] /:id/termo/meta erro:', e);
    res.status(500).json({ error: 'Erro ao obter metadados do termo.' });
  }
});

/**
 * POST /api/portal/eventos/:id/termo/assinafy/link
 * Garante o PDF do termo, envia para a Assinafy (se ainda não enviado) e
 * devolve URL para o cliente iniciar a assinatura no portal.
 */
clientRouter.post('/:id/termo/assinafy/link', async (req, res) => {
  try {
    const eventoId = req.params.id;

    // Garante PDF do termo
    let doc = await dbGet(
      `SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [eventoId]
    );
    if (!doc || !doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
      await gerarTermoEventoPdfkitEIndexar(eventoId);
      doc = await dbGet(`SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY created_at DESC, id DESC LIMIT 1`, [eventoId]);
    }
    if (!doc || !doc.pdf_url || !fs.existsSync(doc.pdf_url)) {
      return res.status(409).json({ error: 'PDF do termo não encontrado.' });
    }

    // Se já existe id na Assinafy, devolve rota para abrir
    if (doc.assinafy_id) {
      return res.json({
        ok: true,
        id: doc.assinafy_id,
        url: null,
        open_url: `/api/documentos/assinafy/${encodeURIComponent(doc.assinafy_id)}/open`
      });
    }

    // Envia o PDF para a Assinafy agora
    const buffer = fs.readFileSync(doc.pdf_url);
    const filename = path.basename(doc.pdf_url);
    const callbackUrl = process.env.ASSINAFY_CALLBACK_URL || undefined; // opcional
    const resp = await uploadPdf(buffer, filename, { callbackUrl });

    await dbRun(
      `UPDATE documentos SET assinafy_id = ?, status = 'enviado' WHERE id = ?`,
      [resp.id, doc.id]
    );

    // Algumas APIs retornam uma URL de assinatura direta; se não, usamos nossa rota de "open"
    const open_url =
      resp.url || resp.signUrl || resp.signerUrl || resp.signingUrl ||
      `/api/documentos/assinafy/${encodeURIComponent(resp.id)}/open`;

    return res.json({ ok: true, id: resp.id, url: resp.url || null, open_url });
  } catch (e) {
    console.error('[PORTAL] assinafy link erro:', e?.response?.data || e);
    res.status(500).json({ error: 'Falha ao iniciar assinatura.' });
  }
});

/**
 * PUT /api/portal/eventos/:id/remarcar
 * Permite ao cliente remarcar o evento uma única vez.
 */
clientRouter.put('/:id/remarcar', async (req, res) => {
  try {
    const eventoId = req.params.id;
    const { nova_data, justificativa } = req.body || {};
    if (!nova_data) return res.status(400).json({ error: 'Nova data é obrigatória.' });
    if (!justificativa || !String(justificativa).trim()) {
      return res.status(400).json({ error: 'Justificativa é obrigatória.' });
    }

    const ev = await dbGet(
      `SELECT remarcado, remarcacao_solicitada FROM Eventos WHERE id = ? AND id_cliente = ?`,
      [eventoId, req.user.id]
    );
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
    if (Number(ev.remarcado) || Number(ev.remarcacao_solicitada)) {
      return res.status(400).json({ error: 'Evento já remarcado ou com remarcação solicitada.' });
    }

    const agora = new Date().toISOString();
    const datasNovas = JSON.stringify([nova_data]);

    await dbRun(
      `UPDATE Eventos
         SET remarcacao_solicitada = 1,
             data_pedido_remarcacao = ?,
             datas_evento_solicitada = ?,
             justificativa_remarcacao = ?,
             remarcado = 0
       WHERE id = ?`,
      [agora, datasNovas, justificativa, eventoId]
    );

    res.json({ ok: true, pending: true });
  } catch (err) {
    console.error('[PORTAL] /:id/remarcar erro:', err);
    res.status(500).json({ error: 'Erro ao remarcar o evento.' });
  }
});

/**
 * POST /api/portal/eventos/dars/:id/reemitir
 * Reemite uma DAR vinculada a um evento do cliente logado.
 */
clientRouter.post('/dars/:id/reemitir', async (req, res) => {
  try {
    const darId = Number(req.params.id);
    const row = await dbGet(
      `SELECT d.*, e.id_cliente,
              ce.nome_razao_social AS nome,
              TRIM(ce.documento) AS documento,
              TRIM(ce.documento_responsavel) AS documento_responsavel
         FROM dars d
         JOIN DARs_Eventos de ON de.id_dar = d.id
         JOIN Eventos e        ON e.id = de.id_evento
         JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
        WHERE d.id = ?
        LIMIT 1`,
      [darId]
    );
    if (!row) return res.status(404).json({ error: 'DAR não encontrada.' });
    if (row.id_cliente !== req.user.id) {
      return res.status(403).json({ error: 'Este DAR não pertence ao seu evento.' });
    }

    let dar = { ...row };
    const enc = await calcularEncargosAtraso(dar).catch(() => null);
    if (enc) {
      if (enc.valorAtualizado != null) dar.valor = enc.valorAtualizado;
      if (enc.novaDataVencimento) {
        const nova = new Date(enc.novaDataVencimento);
        const original = new Date(row.data_vencimento);
        if (nova > original) {
          dar.data_vencimento = enc.novaDataVencimento;
        }
      }
    }

    const docCliente = onlyDigits(row.documento);
    const docResp    = onlyDigits(row.documento_responsavel);
    const doc        = [docCliente, docResp].find(d => isCpf(d) || isCnpj(d));
    const nome = row.nome || 'Contribuinte';
    if (!doc) {
      return res.status(400).json({ error: 'Documento do cliente ausente ou inválido.' });
    }
    const tipo = isCpf(doc) ? 3 : 4;
    const codigoIbgeMunicipio = 2704302;

    const mes  = dar.mes_referencia || Number(String(dar.data_vencimento).slice(5, 7));
    const ano  = dar.ano_referencia || Number(String(dar.data_vencimento).slice(0, 4));
    const venc = String(dar.data_vencimento).slice(0, 10);

    const receitaCodigo = tipo === 3 ? 20165 : 20164;
    const observacao = nome ? `Evento CIPT - ${nome}` : 'Evento CIPT';

    const payload = {
      contribuinteEmitente: { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio },
      receitas: [{
        codigo: receitaCodigo,
        competencia: { mes, ano },
        valorPrincipal: Number(dar.valor),
        valorDesconto: 0,
        dataVencimento: venc
      }],
      dataLimitePagamento: venc,
      observacao
    };
    const guiaLike = {
      codigo: receitaCodigo,
      competencia: { mes, ano },
      valorPrincipal: Number(dar.valor),
      valorDesconto: 0,
      dataVencimento: venc,
      observacao
    };

    let sefaz;
    try {
      sefaz = await emitirGuiaSefaz(payload);
    } catch (e1) {
      console.warn('[PORTAL][dars/:id/reemitir] payload único falhou -> tentando (contrib, guiaLike):', e1?.message);
      sefaz = await emitirGuiaSefaz({ codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio }, guiaLike);
    }

    if (!sefaz || !sefaz.numeroGuia || !sefaz.pdfBase64) {
      return res.status(502).json({ error: 'Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).' });
    }

    const tokenDoc = `DAR-${sefaz.numeroGuia}`;
    const pdfComToken = await imprimirTokenEmPdf(sefaz.pdfBase64, tokenDoc);

    await dbRun(
      `UPDATE dars
          SET numero_documento = ?,
              pdf_url          = ?,
              status           = CASE WHEN COALESCE(status,'') IN ('','Pendente','Vencido','Vencida') THEN 'Reemitido' ELSE status END,
              data_emissao     = COALESCE(data_emissao, date('now')),
              emitido_por_id   = COALESCE(emitido_por_id, ?),
              valor            = ?,
              data_vencimento  = ?
        WHERE id = ?`,
      [sefaz.numeroGuia, pdfComToken, req.user?.id || null, dar.valor, dar.data_vencimento, darId]
    );

    const ld = sefaz.linhaDigitavel || sefaz.linha_digitavel || null;
    const cb = sefaz.codigoBarras || sefaz.codigo_barras || null;
    if (ld || cb) {
      await dbRun(
        `UPDATE dars SET linha_digitavel = COALESCE(?, linha_digitavel),
                         codigo_barras  = COALESCE(?, codigo_barras)
         WHERE id = ?`,
        [ld, cb, darId]
      );
    }

    return res.json({ ok: true, numero: sefaz.numeroGuia, dar_pdf: pdfComToken });
  } catch (err) {
    console.error('[PORTAL] ERRO POST /dars/:id/reemitir:', err);
    return res.status(400).json({ error: err.message || 'Falha ao reemitir a DAR.' });
  }
});

clientRouter.get('/me', async (req, res) => {
  const clienteId = req.user.id;
  try {
    const fetchUser = dbGet(`SELECT * FROM Clientes_Eventos WHERE id = ?`, [clienteId]);
    const fetchEventos = dbAll(`SELECT * FROM Eventos WHERE id_cliente = ? ORDER BY id DESC`, [clienteId]);
    const fetchDars = dbAll(
      `SELECT d.*, de.id_evento, de.numero_parcela, de.valor_parcela
         FROM dars d
         JOIN DARs_Eventos de ON de.id_dar = d.id
         JOIN Eventos e ON e.id = de.id_evento
        WHERE e.id_cliente = ?
        ORDER BY d.data_vencimento DESC, d.id DESC`,
      [clienteId]
    );

    const [user, eventos, dars] = await Promise.all([fetchUser, fetchEventos, fetchDars]);
    if (!user) return res.status(404).json({ error: 'Cliente não encontrado.' });

    delete user.senha_hash;
    delete user.token_definir_senha;

    res.json({ user, eventos, dars });
  } catch (err) {
    console.error('[CLIENTE-EVENTO]/me erro:', err);
    return res.status(500).json({ error: 'Erro interno ao buscar os dados do cliente.' });
  }
});

clientRouter.put('/me', (req, res) => {
  const clienteId = req.user.id;
  const {
    telefone, nomeResponsavel, cep, logradouro, numero, bairro, cidade, uf, complemento
  } = req.body;

  const enderecoCompleto = (
    `${logradouro || ''}, ${numero || ''}` +
    `${complemento ? ' ' + complemento : ''} - ` +
    `${bairro || ''}, ${cidade || ''} - ${(uf || '').toUpperCase()}, ${cep || ''}`
  ).replace(/\s+/g, ' ').trim();

  const sql = `
    UPDATE Clientes_Eventos SET
      telefone = ?, nome_responsavel = ?, cep = ?, logradouro = ?, 
      numero = ?, bairro = ?, cidade = ?, uf = ?, endereco = ?, complemento = ?
    WHERE id = ?
  `;
  const params = [
    onlyDigits(telefone || ''), nomeResponsavel || null, onlyDigits(cep || ''), logradouro || null,
    (numero ?? '').toString(), bairro || null, cidade || null, (uf || '').toUpperCase(),
    enderecoCompleto || null, complemento || null, clienteId
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error('[CLIENTE-EVENTO]/me UPDATE erro:', err.message);
      return res.status(500).json({ error: 'Erro ao atualizar o cliente no banco de dados.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
    return res.json({ message: 'Cliente atualizado com sucesso.', id: clienteId });
  });
});

clientRouter.post('/change-password', (req, res) => {
  const clienteId = req.user.id;
  const { senha_atual, nova_senha, confirmar_nova_senha } = req.body;

  if (!senha_atual || !nova_senha || !confirmar_nova_senha) {
    return res.status(400).json({ error: 'Todos os campos de senha são obrigatórios.' });
    }
  if (nova_senha !== confirmar_nova_senha) {
    return res.status(400).json({ error: 'As novas senhas não coincidem.' });
  }

  db.get(`SELECT senha_hash FROM Clientes_Eventos WHERE id = ?`, [clienteId], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const match = await bcrypt.compare(senha_atual, user.senha_hash || '');
    if (!match) return res.status(401).json({ error: 'A senha atual está incorreta.' });

    const novaSenhaHash = await bcrypt.hash(nova_senha, SALT_ROUNDS);
    db.run(`UPDATE Clientes_Eventos SET senha_hash = ? WHERE id = ?`, [novaSenhaHash, clienteId], (err2) => {
      if (err2) {
        console.error('[CLIENTE-EVENTO]/change-password erro:', err2.message);
        return res.status(500).json({ error: 'Erro ao atualizar a senha.' });
      }
      res.json({ message: 'Senha alterada com sucesso!' });
    });
  });
});

/* ===================================================================
   ROTAS PÚBLICAS (Login/Definir Senha) — sem token
   =================================================================== */

publicRouter.post('/definir-senha', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha) return res.status(400).json({ error: 'Token e senha são obrigatórios.' });

  const sql = `SELECT id, token_definir_senha_expires FROM Clientes_Eventos WHERE token_definir_senha = ?`;
  db.get(sql, [token], async (err, cliente) => {
    if (err) return res.status(500).json({ error: 'Erro interno no servidor.' });
    if (!cliente) return res.status(404).json({ error: 'Token inválido ou já utilizado.' });

    const now = Date.now();
    if (!cliente.token_definir_senha_expires || now > Number(cliente.token_definir_senha_expires)) {
      return res.status(400).json({ error: 'Token expirado.' });
    }

    try {
      const senha_hash = await bcrypt.hash(senha, SALT_ROUNDS);
      const updateSql = `UPDATE Clientes_Eventos SET senha_hash = ?, token_definir_senha = NULL, token_definir_senha_expires = NULL WHERE id = ?`;
      db.run(updateSql, [senha_hash, cliente.id], function (err2) {
        if (err2) return res.status(500).json({ error: 'Não foi possível atualizar a senha.' });
        res.json({ message: 'Senha definida com sucesso!' });
      });
    } catch (hashError) {
      res.status(500).json({ error: 'Erro interno ao processar a senha.' });
    }
  });
});

publicRouter.get('/definir-senha/validar', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ ok: false, error: 'Token ausente.' });

  const sql = `SELECT id, nome_razao_social, token_definir_senha_expires FROM Clientes_Eventos WHERE token_definir_senha = ?`;
  db.get(sql, [token], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: 'Erro interno.' });
    if (!row) return res.status(404).json({ ok: false, error: 'Token inválido ou já utilizado.' });

    const now = Date.now();
    if (!row.token_definir_senha_expires || now > Number(row.token_definir_senha_expires)) {
      return res.status(400).json({ ok: false, error: 'Token expirado.' });
    }

    res.json({ ok: true, cliente: { id: row.id, nome: row.nome_razao_social } });
  });
});

publicRouter.post('/login', (req, res) => {
  const { login, senha } = req.body;
  if (!login || !senha) {
    return res.status(400).json({ error: 'Login e senha são obrigatórios.' });
  }

  const sql = `SELECT id, nome_razao_social, email, senha_hash FROM Clientes_Eventos WHERE email = ? OR documento = ?`;
  db.get(sql, [login, onlyDigits(login)], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
    if (!row || !row.senha_hash) {
      return res.status(401).json({ error: 'Credenciais inválidas ou cadastro não finalizado.' });
    }

    const ok = await bcrypt.compare(senha, row.senha_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const payload = { id: row.id, nome: row.nome_razao_social, role: 'CLIENTE_EVENTO' };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ message: 'Login realizado com sucesso!', token });
  });
});

/* ===================================================================
   ROTAS DE ADMIN (Gerenciamento) – exigem ADMIN
   =================================================================== */
adminRouter.use(adminAuthMiddleware);

// LISTAR
adminRouter.get('/', (req, res) => {
  const { pendentes } = req.query;
  let sql = `SELECT * FROM Clientes_Eventos`;
  if (pendentes === 'true') {
    sql +=
      ` WHERE (telefone IS NULL OR TRIM(telefone) = '')` +
      ` OR (email IS NULL OR TRIM(email) = '')` +
      ` OR (endereco IS NULL OR TRIM(endereco) = '')`;
  }
  sql += ' ORDER BY nome_razao_social';
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro interno no servidor.' });
    res.json(rows);
  });
});

// EXPORTAR
adminRouter.get('/export/:format', async (req, res) => {
  const { format } = req.params;
  const { pendentes } = req.query;
  try {
    let where = '';
    if (pendentes === 'true') {
      where =
        ` WHERE (telefone IS NULL OR TRIM(telefone) = '')` +
        ` OR (email IS NULL OR TRIM(email) = '')` +
        ` OR (endereco IS NULL OR TRIM(endereco) = '')`;
    }
    const rows = await dbAll(
      `SELECT nome_razao_social, tipo_pessoa, documento, email, telefone, cep, logradouro, numero, complemento, bairro, cidade, uf, endereco FROM Clientes_Eventos${where} ORDER BY nome_razao_social`
    );
    if (!rows.length) {
      return res.status(404).send('Nenhum dado encontrado para exportar.');
    }
    if (format === 'csv') {
      const csv = new Parser().parse(rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('clientes_eventos.csv');
      return res.send(csv);
    }
    if (format === 'xlsx') {
      const ws = xlsx.utils.json_to_sheet(rows);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, 'Clientes');
      const buf = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
      res.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.attachment('clientes_eventos.xlsx');
      return res.send(buf);
    }
    return res.status(400).json({ error: 'Formato de exportação inválido.' });
  } catch (err) {
    console.error('[ADMIN EVENTOS CLIENTES][EXPORT] ERRO:', err.message);
    res.status(500).json({ error: 'Erro ao exportar os dados.' });
  }
});

// CRIAR (corrigido: sem tipoNormalizado, PF/PJ correto, endereço e token)
adminRouter.post('/', async (req, res) => {
  let {
    nome_razao_social, tipo_pessoa, documento, email, telefone,
    nome_responsavel, tipo_cliente, documento_responsavel,
    cep, logradouro, numero, complemento, bairro, cidade, uf
  } = req.body || {};

  const tp = normalizeTipoPessoa(tipo_pessoa);
  if (!tp || !documento || !email || !tipo_cliente) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  documento = onlyDigits(documento);
  const docOk = (tp === 'PF' && isCpf(documento)) || (tp === 'PJ' && isCnpj(documento));
  if (!docOk) {
    return res.status(400).json({ error: 'Documento inválido (CPF/CNPJ).' });
  }

  let cnpjData = null;
  if (tp === 'PJ') {
    try {
      cnpjData = await fetchCnpjData(documento);
      if (!cnpjData) {
        console.error(`[ADMIN EVENTOS CLIENTES][POST] CNPJ ${documento} não encontrado na API.`);
      }
    } catch (e) {
      console.error('[ADMIN EVENTOS CLIENTES][POST] CNPJ lookup erro:', e?.message);
    }
    if (cnpjData) {
      nome_razao_social = nome_razao_social || cnpjData.razao_social || cnpjData.nome_fantasia;
      logradouro = logradouro || cnpjData.logradouro;
      bairro = bairro || cnpjData.bairro;
      cidade = cidade || cnpjData.cidade;
      uf = uf || cnpjData.uf;
      cep = cep || cnpjData.cep;
    }
  }

  if (cep !== undefined && cep !== null && String(cep).trim() !== '') {
    try {
      const cepDigits = onlyDigits(cep);
      const addr = await fetchCepAddress(cepDigits);
      cep = cepDigits;
      logradouro = addr.logradouro;
      bairro = addr.bairro;
      cidade = addr.localidade;
      uf = addr.uf;
    } catch (e) {
      return res.status(400).json({ error: e.message || 'CEP inválido' });
    }
  }

  if (!nome_razao_social) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  const telDigits      = onlyDigits(telefone || '');
  const docRespDigits  = tp === 'PJ' ? onlyDigits(documento_responsavel || '') : null;
  const nomeResp       = tp === 'PJ' ? (nome_responsavel || null) : null;

  const enderecoCompleto = (
    `${logradouro || ''}, ${numero || ''}` +
    `${complemento ? ' ' + complemento : ''} - ` +
    `${bairro || ''}, ${cidade || ''} - ${(uf || '').toUpperCase()}, ${cep || ''}`
  ).replace(/\s+/g, ' ').trim();

  try {
    const token = crypto.randomBytes(32).toString('hex');

    const sql = `INSERT INTO Clientes_Eventos (
      nome_razao_social, tipo_pessoa, documento, email, telefone,
      nome_responsavel, tipo_cliente, token_definir_senha, documento_responsavel,
      cep, logradouro, numero, complemento, bairro, cidade, uf, endereco
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const params = [
      String(nome_razao_social).trim(), tp, documento, String(email).trim(),
      telDigits || null, nomeResp, String(tipo_cliente).trim(), token, docRespDigits,
      cep || '', logradouro || null, (numero ?? '').toString(), complemento || null,
      bairro || null, cidade || null, (uf || '').toUpperCase(), enderecoCompleto || null
    ];

    db.run(sql, params, async function (err) {
      if (err) {
        console.error('[ADMIN EVENTOS CLIENTES][POST] SQL erro:', err.message, '| params:', params);
        if (String(err.message).includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'Já existe um cliente com este CPF/CNPJ.' });
        }
        return res.status(500).json({ error: 'Erro ao salvar o cliente no banco de dados.' });
      }

      try {
        await enviarEmailDefinirSenha(email, nome_razao_social, token);
        res.status(201).json({ id: this.lastID, message: 'Cliente criado com sucesso. E-mail para definição de senha enviado.' });
      } catch (emailError) {
        console.error('[ADMIN EVENTOS CLIENTES][POST] E-mail falhou:', emailError?.message);
        res.status(201).json({ id: this.lastID, message: 'Cliente criado, mas houve falha ao enviar o e-mail de definição de senha.' });
      }
    });
  } catch (error) {
    console.error('[ADMIN EVENTOS CLIENTES][POST] Erro inesperado:', error);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// ATUALIZAR
adminRouter.put('/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const tp = normalizeTipoPessoa(body.tipo_pessoa);
  const rawCep = body.cep;
  const safe = {
    nome_razao_social    : (body.nome_razao_social ?? body.nome ?? '').trim(),
    tipo_pessoa          : tp,
    documento            : onlyDigits(body.documento ?? ''),
    email                : (body.email ?? '').trim(),
    telefone             : onlyDigits(body.telefone ?? ''),
    nome_responsavel     : tp === 'PJ' ? (body.nome_responsavel ?? '').trim() : null,
    tipo_cliente         : (body.tipo_cliente ?? 'Geral').trim(),
    documento_responsavel: tp === 'PJ' ? onlyDigits(body.documento_responsavel ?? '') : null,
    cep                  : onlyDigits(rawCep ?? ''),
    logradouro           : (body.logradouro ?? '').trim(),
    numero               : (body.numero ?? '').toString().trim(),
    complemento          : (body.complemento ?? '').trim(),
    bairro               : (body.bairro ?? '').trim(),
    cidade               : (body.cidade ?? '').trim(),
    uf                   : (body.uf ?? '').toString().trim().toUpperCase().slice(0, 2),
  };

  if (!safe.nome_razao_social || !safe.tipo_pessoa || !safe.documento || !safe.email || !safe.tipo_cliente) {
    return res.status(400).json({ error: 'Campos obrigatórios estão faltando.' });
  }

  const docOk = (safe.tipo_pessoa === 'PF' && isCpf(safe.documento)) ||
                (safe.tipo_pessoa === 'PJ' && isCnpj(safe.documento));
  if (!docOk) return res.status(400).json({ error: 'Documento inválido (CPF/CNPJ).' });

  if (rawCep !== undefined && String(rawCep).trim() !== '') {
    try {
      const addr = await fetchCepAddress(safe.cep);
      safe.logradouro = addr.logradouro;
      safe.bairro = addr.bairro;
      safe.cidade = addr.localidade;
      safe.uf = addr.uf;
    } catch (e) {
      return res.status(400).json({ error: e.message || 'CEP inválido' });
    }
  }

  const enderecoCompleto = (
    `${safe.logradouro || ''}, ${safe.numero || ''}` +
    `${safe.complemento ? ' ' + safe.complemento : ''} - ` +
    `${safe.bairro || ''}, ${safe.cidade || ''} - ${safe.uf || ''}, ${safe.cep || ''}`
  ).replace(/\s+/g, ' ').trim();

  safe.endereco = enderecoCompleto || null;

  const sql = `
    UPDATE Clientes_Eventos SET
      nome_razao_social = ?, tipo_pessoa = ?, documento = ?, email = ?,
      telefone = ?, nome_responsavel = ?, tipo_cliente = ?, documento_responsavel = ?,
      cep = ?, logradouro = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, endereco = ?
    WHERE id = ?
  `;
  const params = [
    safe.nome_razao_social, safe.tipo_pessoa, safe.documento, safe.email,
    safe.telefone || null, safe.nome_responsavel, safe.tipo_cliente, safe.documento_responsavel,
    safe.cep, safe.logradouro || null, safe.numero, safe.complemento || null, safe.bairro || null,
    safe.cidade || null, safe.uf, safe.endereco, id
  ];

  try {
    const oldRow = await dbGet('SELECT telefone, email, endereco FROM Clientes_Eventos WHERE id = ?', [id]);
    if (!oldRow) {
      return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
    }

    await dbRun(sql, params);

    await dbRun(`CREATE TABLE IF NOT EXISTS Clientes_Eventos_Audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      campo TEXT NOT NULL,
      valor_antigo TEXT,
      valor_novo TEXT,
      alterado_em TEXT DEFAULT CURRENT_TIMESTAMP,
      alterado_por INTEGER
    )`);

    const campos = {
      telefone: safe.telefone || null,
      email: safe.email,
      endereco: safe.endereco
    };
    const adminId = req.user?.id || null;
    for (const [campo, novo] of Object.entries(campos)) {
      const antigo = oldRow[campo];
      if (String(antigo || '') !== String(novo || '')) {
        await dbRun(
          `INSERT INTO Clientes_Eventos_Audit (cliente_id, campo, valor_antigo, valor_novo, alterado_por) VALUES (?, ?, ?, ?, ?)`,
          [id, campo, antigo || null, novo || null, adminId]
        );
      }
    }

    res.json({ message: 'Cliente atualizado com sucesso.', id });
  } catch (err) {
    console.error('[EVENTOS-CLIENTES][UPDATE] ERRO:', err.message);
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Já existe um cliente com este CPF/CNPJ.' });
    }
    if (String(err.message).includes('CHECK constraint failed')) {
      return res.status(400).json({ error: "Valor inválido para 'tipo_pessoa'. Use 'PF' ou 'PJ'." });
    }
    res.status(500).json({ error: 'Erro ao atualizar o cliente no banco de dados.' });
  }
});


adminRouter.patch('/:id/cpf', async (req, res) => {
  const { id } = req.params;
  let { documento_responsavel } = req.body || {};
  documento_responsavel = onlyDigits(documento_responsavel || '');
  if (!isCpf(documento_responsavel)) {
    return res.status(400).json({ error: 'CPF inválido.' });
  }
  try {
    const result = await dbRun(`UPDATE Clientes_Eventos SET documento_responsavel = ? WHERE id = ?`, [documento_responsavel, id]);
    if (!result.changes) {
      return res.status(404).json({ error: 'Cliente de evento não encontrado.' });
    }
    res.json({ message: 'CPF do responsável atualizado com sucesso.' });
  } catch (err) {
    console.error('[EVENTOS-CLIENTES][PATCH CPF] ERRO:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar CPF do responsável.' });
  }
});

// REENVIAR LINK DE DEFINIÇÃO DE SENHA
adminRouter.post('/:id/reenviar-senha', async (req, res) => {
  const { id } = req.params;
  try {
    const cliente = await dbGet(
      `SELECT email, nome_razao_social, token_definir_senha, token_definir_senha_expires FROM Clientes_Eventos WHERE id = ?`,
      [id]
    );
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });

    let { token_definir_senha: token, token_definir_senha_expires: exp } = cliente;
    const now = Date.now();
    if (!token || !exp || now > Number(exp)) {
      token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now + 60 * 60 * 1000; // 1h
      await dbRun(
        `UPDATE Clientes_Eventos SET token_definir_senha = ?, token_definir_senha_expires = ? WHERE id = ?`,
        [token, expiresAt, id]
      );
    }

    const ok = await enviarEmailDefinirSenha(
      cliente.email,
      cliente.nome_razao_social,
      token
    );
    if (!ok) return res.status(500).json({ error: 'Falha ao enviar e-mail.' });

    res.json({ ok: true, message: 'E-mail de definição de senha reenviado.' });
  } catch (err) {
    console.error('[ADMIN EVENTOS CLIENTES][REENVIAR SENHA] ERRO:', err.message);
    res.status(500).json({ error: 'Erro ao reenviar senha.' });
  }
});

module.exports = {
  adminRoutes:  adminRouter,
  publicRoutes: publicRouter,
  clientRoutes: clientRouter
};
