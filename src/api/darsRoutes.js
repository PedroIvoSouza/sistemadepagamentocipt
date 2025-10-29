// Em: src/api/darsRoutes.js
const express = require('express');
const fs = require('fs');
const multer = require('multer');

const authMiddleware = require('../middleware/authMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { linhaDigitavelParaCodigoBarras } = require('../utils/boleto');
const {
  ensureSolicitacoesSchema,
  armazenarAnexo,
  registrarSolicitacao,
  obterUltimasSolicitacoesPorDar,
  parseDataPagamento,
} = require('../services/darBaixaManualService');

const db = require('../database/db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const DAR_GUIA_DOCUMENTO_TIPO = 'DAR_GUIA_MANUAL';
const DAR_COMPROVANTE_DOCUMENTO_TIPO = 'DAR_COMPROVANTE_MANUAL';

// helpers async
const dbGetAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAllAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const dbRunAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

// Sanity check (log inicial)
(async () => {
  try {
    const colsDars = (await dbAllAsync('PRAGMA table_info(dars)')).map(c => c.name);
    const colsPerm = (await dbAllAsync('PRAGMA table_info(permissionarios)')).map(c => c.name);

    console.log('[DB] dars colunas:', colsDars.join(', '));
    console.log('[DB] permissionarios colunas:', colsPerm.join(', '));

    const missing = [];
    if (!colsDars.includes('numero_documento')) missing.push('dars.numero_documento');
    if (!colsDars.includes('pdf_url')) missing.push('dars.pdf_url');
    if (!colsDars.includes('linha_digitavel')) missing.push('dars.linha_digitavel');
    if (!colsPerm.includes('numero_documento')) missing.push('permissionarios.numero_documento');
    if (!colsPerm.includes('telefone_cobranca')) missing.push('permissionarios.telefone_cobranca');
    if (!colsPerm.includes('tipo')) missing.push('permissionarios.tipo');

    if (missing.length) {
      console.warn('⚠️  Colunas ausentes no DB atual:', missing.join(' | '));
      console.warn('    Verifique se SQLITE_STORAGE aponta para o arquivo migrado.');
    }
  } catch (e) {
    console.warn('Não foi possível inspecionar o schema do DB:', e.message);
  }
})();

// Auto-migrate (garante colunas usadas no código)
async function getTableColumns(table) {
  const sql = `PRAGMA table_info(${table})`;
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
async function ensureColumn(table, column, type) {
  const cols = await getTableColumns(table);
  if (!cols.length) {
    console.warn(`[MIGRATE] Tabela ${table} ausente; pulando ${column}.`);
    return;
  }
  const exists = cols.some(c => String(c.name).toLowerCase() === String(column).toLowerCase());
  if (!exists) {
    console.log(`[MIGRATE] Criando coluna ${table}.${column} ${type}...`);
    await dbRunAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } else {
    console.log(`[MIGRATE] OK: ${table}.${column} já existe.`);
  }
}
async function ensureSchema() {
  await ensureColumn('dars', 'numero_documento', 'TEXT');
  await ensureColumn('dars', 'pdf_url', 'TEXT');
  await ensureColumn('dars', 'linha_digitavel', 'TEXT');
  await ensureColumn('dars', 'data_emissao', 'TEXT');
  await ensureColumn('dars', 'emitido_por_id', 'INTEGER');
  await ensureColumn('dars', 'advertencia_fatos', 'TEXT');
  await ensureColumn('permissionarios', 'numero_documento', 'TEXT');
  await ensureColumn('permissionarios', 'telefone_cobranca', 'TEXT');
  await ensureColumn('permissionarios', 'tipo', 'TEXT');
}
// dispara sem bloquear
ensureSchema().catch(err => console.error('[MIGRATE] Falha garantindo schema:', err));
ensureSolicitacoesSchema(db).catch((err) => {
  console.error('[DARs] Falha ao garantir schema de solicitações de baixa:', err?.message || err);
});

// === Utils ==================================================================
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

// YYYY-MM-DD no horário local
const isoHojeLocal = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

// Aceita Date ou string e devolve YYYY-MM-DD (ou null)
const toISO = (d) => {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return null;
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

// Monta payload da SEFAZ para permissionários
function buildSefazPayloadPermissionario({ perm, darLike }) {
  const cnpj = onlyDigits(perm.cnpj || '');
  if (cnpj.length !== 14) throw new Error(`CNPJ inválido para o permissionário: ${perm.cnpj || 'vazio'}`);

  // vencimento do DAR
  let dataVenc = toISO(darLike.data_vencimento);
  if (!dataVenc) throw new Error(`Data de vencimento inválida: ${darLike.data_vencimento}`);

  // limite >= hoje
  const hoje = isoHojeLocal();
  const dataLimitePagamento = dataVenc < hoje ? hoje : dataVenc;

  // competência
  let compMes = Number(darLike.mes_referencia);
  let compAno = Number(darLike.ano_referencia);
  if (!compMes || !compAno) {
    const [yyyy, mm] = dataVenc.split('-');
    compMes = compMes || Number(mm);
    compAno = compAno || Number(yyyy);
  }

  const codigoIbge = Number(process.env.COD_IBGE_MUNICIPIO || 0);
  const receitaCod = Number(String(process.env.RECEITA_CODIGO_PERMISSIONARIO).replace(/\D/g, ''));
  if (!codigoIbge) throw new Error('COD_IBGE_MUNICIPIO não configurado (.env).');
  if (!receitaCod) throw new Error('RECEITA_CODIGO_PERMISSIONARIO inválido.');

  // Sem depender de colunas endereco/cep (usa fallbacks .env)
  const descricaoEndereco = (process.env.ENDERECO_PADRAO || 'R. Barão de Jaraguá, 590 - Jaraguá, Maceió/AL');
  const numeroCep = onlyDigits(process.env.CEP_PADRAO || '57020000');

  const valorPrincipal = Number(darLike.valor || 0);
  if (!(valorPrincipal > 0)) throw new Error(`Valor do DAR inválido: ${darLike.valor}`);

  return {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: 4, // 3=CPF, 4=CNPJ
      numeroInscricao: cnpj,
      nome: perm.nome_empresa || 'Contribuinte',
      codigoIbgeMunicipio: codigoIbge,
      descricaoEndereco,
      numeroCep
    },
    receitas: [
      {
        codigo: receitaCod,
        competencia: { mes: compMes, ano: compAno },
        valorPrincipal,
        valorDesconto: 0.0,
        dataVencimento: dataVenc
      }
    ],
    dataLimitePagamento,
    observacao: `Aluguel CIPT - ${String(perm.nome_empresa || '').slice(0, 60)}`
  };
}

// === Rotas ==================================================================

// Listagem dos DARs do permissionário logado
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { ano, status } = req.query;

    let sql = `SELECT * FROM dars WHERE permissionario_id = ?`;
    const params = [userId];

    if (ano && ano !== 'todos') {
      sql += ` AND ano_referencia = ?`;
      params.push(ano);
    }
    if (status && status !== 'todos') {
      if (status === 'Vencido') {
        sql += ` AND status IN ('Vencido','Vencida')`;
      } else {
        sql += ` AND status = ?`;
        params.push(status);
      }
    }

    sql += ` ORDER BY ano_referencia DESC, mes_referencia DESC`;

    const rows = await dbAllAsync(sql, params);
    const darIds = rows.map((row) => row.id).filter((id) => Number.isInteger(id));
    const solicitacoesMap = await obterUltimasSolicitacoesPorDar(db, darIds);

    const enriched = rows.map((row) => {
      const solicitacao = solicitacoesMap.get(row.id);
      if (!solicitacao) return row;
      return {
        ...row,
        baixa_manual: {
          id: solicitacao.id,
          status: solicitacao.status,
          data_pagamento: solicitacao.data_pagamento,
          criado_em: solicitacao.criado_em,
          atualizado_em: solicitacao.atualizado_em,
        },
      };
    });

    return res.status(200).json(enriched);
  } catch (err) {
    console.error('[DARs] ERRO GET /api/dars:', err);
    return res.status(500).json({ error: 'Erro de banco de dados.' });
  }
});

router.post(
  '/:id/solicitacoes-baixa',
  [
    authMiddleware,
    upload.fields([
      { name: 'guia', maxCount: 1 },
      { name: 'comprovante', maxCount: 1 },
    ]),
  ],
  async (req, res) => {
    const arquivosCriados = [];
    try {
      const permissionarioId = req.user.id;
      const darId = Number(req.params.id);
      if (!Number.isInteger(darId) || darId <= 0) {
        return res.status(400).json({ error: 'Identificador de DAR inválido.' });
      }

      const dar = await dbGetAsync('SELECT * FROM dars WHERE id = ? AND permissionario_id = ?', [darId, permissionarioId]);
      if (!dar) {
        return res.status(404).json({ error: 'DAR não encontrado.' });
      }

      await ensureSolicitacoesSchema(db);
      const pendente = await dbGetAsync(
        `SELECT * FROM dar_baixa_solicitacoes WHERE dar_id = ? AND LOWER(status) = 'pendente' ORDER BY criado_em DESC LIMIT 1`,
        [darId]
      );
      if (pendente) {
        return res.status(409).json({ error: 'Já existe uma solicitação de baixa pendente para este DAR.' });
      }

      const rawDataPagamento =
        req.body?.dataPagamento ??
        req.body?.data_pagamento ??
        req.body?.paymentDate ??
        req.body?.data ??
        null;
      const dataPagamentoISO = parseDataPagamento(rawDataPagamento);

      const files = req.files || {};
      const guiaFile = Array.isArray(files.guia) ? files.guia[0] : null;
      const comprovanteFile = Array.isArray(files.comprovante) ? files.comprovante[0] : null;

      if (!guiaFile) {
        return res.status(400).json({ error: 'Envie a guia do DAR que foi paga.' });
      }
      if (!comprovanteFile) {
        return res.status(400).json({ error: 'Envie o comprovante de pagamento.' });
      }

      const guia = await armazenarAnexo({
        db,
        darId,
        permissionarioId,
        arquivo: guiaFile,
        tipoDocumento: DAR_GUIA_DOCUMENTO_TIPO,
        campoLabel: 'guia do DAR',
        prefixoArquivo: 'guia_solicitacao',
      });
      arquivosCriados.push({ atual: guia.filePath, anterior: guia.previousPath });

      const comprovante = await armazenarAnexo({
        db,
        darId,
        permissionarioId,
        arquivo: comprovanteFile,
        tipoDocumento: DAR_COMPROVANTE_DOCUMENTO_TIPO,
        campoLabel: 'comprovante do pagamento',
        prefixoArquivo: 'comprovante_solicitacao',
      });
      arquivosCriados.push({ atual: comprovante.filePath, anterior: comprovante.previousPath });

      const observacao = req.body?.observacao || req.body?.comentario || null;

      const solicitacaoId = await registrarSolicitacao({
        db,
        darId,
        permissionarioId,
        solicitadoPorTipo: 'permissionario',
        solicitadoPorId: permissionarioId,
        status: 'pendente',
        dataPagamentoISO,
        guiaToken: guia.token,
        comprovanteToken: comprovante.token,
        adminObservacao: observacao,
      });

      return res.status(201).json({
        ok: true,
        solicitacao_id: solicitacaoId,
        data_pagamento: dataPagamentoISO,
      });
    } catch (err) {
      for (const info of arquivosCriados) {
        if (info?.atual) {
          try {
            if (fs.existsSync(info.atual)) fs.unlinkSync(info.atual);
          } catch {}
        }
      }
      const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
      console.error('[DARs] ERRO POST /solicitacoes-baixa:', err);
      return res.status(status).json({ error: err?.message || 'Falha ao registrar solicitação de baixa.' });
    }
  }
);

// Recalcular encargos (para DAR vencido)
router.get('/:id/recalcular', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const darId = req.params.id;

  const sql = `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`;
  db.get(sql, [darId, userId], async (err, dar) => {
    if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
    if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

    try {
      const calculo = await calcularEncargosAtraso(dar);
      return res.status(200).json(calculo);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao calcular encargos.' });
    }
  });
});

// Preview do payload que será enviado à SEFAZ
router.get('/:id/preview', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const darId = req.params.id;

  try {
    const dar = await dbGetAsync(
      `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`,
      [darId, userId]
    );
    if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

    const perm = await dbGetAsync(
      `SELECT id, nome_empresa, cnpj, tipo FROM permissionarios WHERE id = ?`,
      [userId]
    );
    if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

    let guiaSource = { ...dar };

    if (['Vencido', 'Vencida'].includes(dar.status)) {
      const calculo = await calcularEncargosAtraso(dar);
      guiaSource.valor = calculo.valorAtualizado;
      return res.status(200).json({ darVencido: true, calculo });
    }

    const payload = buildSefazPayloadPermissionario({ perm, darLike: guiaSource });
    return res.status(200).json({ payloadPreview: payload });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Erro ao montar preview.' });
  }
});

// Emitir guia (chama SEFAZ)
router.post('/:id/emitir', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const darId = req.params.id;
  const debug = String(req.query.debug || '').trim() === '1';
  // opcional: confirmação explícita do usuário via ?force=1 ou { forcar: true }
  const confirmacao = String(
    req.query.force || req.query.forcar || (req.body && (req.body.force || req.body.forcar)) || ''
  )
    .toLowerCase()
    .trim();
  const forcar = confirmacao === '1' || confirmacao === 'true';

  try {
    const dar = await dbGetAsync(
      `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`,
      [darId, userId]
    );
    if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

    const perm = await dbGetAsync(
      `SELECT id, nome_empresa, cnpj, tipo FROM permissionarios WHERE id = ?`,
      [userId]
    );
    if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

    let guiaSource = { ...dar };

    const vencido =
      ['Vencido', 'Vencida'].includes(dar.status) ||
      new Date(dar.data_vencimento) < new Date();

    if (vencido) {
      const calculo = await calcularEncargosAtraso(dar);
      if (!forcar) {
        return res.status(200).json({ darVencido: true, calculo });
      }
      guiaSource.valor = calculo.valorAtualizado;
      guiaSource.data_vencimento = calculo.novaDataVencimento || guiaSource.data_vencimento;
    }

    const payload = buildSefazPayloadPermissionario({ perm, darLike: guiaSource });

    const sefazResponse = await emitirGuiaSefaz(payload);
    // Esperado: { numeroGuia, pdfBase64, (opcional) linhaDigitavel }
    if (!sefazResponse || !sefazResponse.numeroGuia || !sefazResponse.pdfBase64) {
      throw new Error('Retorno da SEFAZ incompleto.');
    }

    const tokenDoc = await gerarTokenDocumento('DAR', userId, db);
    sefazResponse.pdfBase64 = await imprimirTokenEmPdf(sefazResponse.pdfBase64, tokenDoc);

    // Garante schema e atualiza DAR
    await ensureSchema(); // no-op se já existe
    await dbRunAsync(
      `UPDATE dars
         SET numero_documento = ?,
             pdf_url = ?,
             linha_digitavel = COALESCE(?, linha_digitavel),
             valor = ?,
             data_vencimento = ?,
             status = 'Reemitido',
             emitido_por_id = ?,
             data_emissao = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        sefazResponse.numeroGuia,
        sefazResponse.pdfBase64,
        sefazResponse.linhaDigitavel || null,
        guiaSource.valor,
        toISO(guiaSource.data_vencimento),
        userId,
        darId,
      ]
    );

    // Compat com campos antigos: preenche codigo_barras/link_pdf se possível
    const cb = (
      sefazResponse.codigoBarras ||
      linhaDigitavelParaCodigoBarras(sefazResponse.linhaDigitavel || '') ||
      ''
    ).replace(/\D/g, '');

    await dbRunAsync(
      `UPDATE dars
         SET codigo_barras = CASE WHEN length(?) = 44 THEN ? ELSE codigo_barras END,
             link_pdf      = COALESCE(pdf_url, link_pdf)
       WHERE id = ?`,
      [cb, cb, darId]
    );

    const payloadDebug = debug ? { _payloadDebug: payload } : {};
    const forceFlag = forcar ? { forcar: true } : {};
    return res.status(200).json({ ...sefazResponse, token: tokenDoc, ...payloadDebug, ...forceFlag });

  } catch (error) {
    console.error('Erro na rota /emitir:', error);
    const isUnavailable =
      /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|timeout/i.test(
        error.message || ''
      );
    const status = isUnavailable ? 503 : 500;
    return res.status(status).json({ error: error.message || 'Erro interno do servidor.' });
  }
});

module.exports = router;