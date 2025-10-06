// src/api/adminDarsRoutes.js
const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { notificarDarGerado } = require('../services/notificacaoService');
const {
  emitirGuiaSefaz,
} = require('../services/sefazService');
const { buildSefazPayloadPermissionario } = require('../utils/sefazPayload'); // <- reative o helper
const { isoHojeLocal, toISO } = require('../utils/sefazPayload');
const db = require('../database/db');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { gerarComprovante } = require('../services/darComprovanteService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { getLastBusinessDayISO, isBusinessDay, parseDateInput, formatISODate } = require('../utils/businessDays');
const { normalizeMsisdn } = require('../utils/phone');
const whatsappService = require('../services/whatsappService');
const { executarConciliacaoDia } = require('../../cron/conciliarPagamentosmes');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Helpers async
const dbGetAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAllAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRunAsync = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));

let ensuredAdvertenciaColumn = false;
async function ensureAdvertenciaColumn() {
  if (ensuredAdvertenciaColumn) return;
  const cols = await dbAllAsync('PRAGMA table_info(dars)');
  if (!cols.some((c) => String(c.name).toLowerCase() === 'advertencia_fatos')) {
    await dbRunAsync('ALTER TABLE dars ADD COLUMN advertencia_fatos TEXT');
  }
  ensuredAdvertenciaColumn = true;
}

function parseCompetencia(valor) {
  if (!valor && valor !== 0) return null;
  const raw = String(valor).trim();
  if (!raw) return null;

  let mes;
  let ano;

  if (/^\d{4}[-\/]\d{2}$/.test(raw)) {
    const [a, m] = raw.replace('/', '-').split('-');
    ano = Number(a);
    mes = Number(m);
  } else if (/^\d{2}[-\/]\d{4}$/.test(raw)) {
    const [m, a] = raw.replace('/', '-').split('-');
    ano = Number(a);
    mes = Number(m);
  } else {
    return null;
  }

  if (!ano || !mes || mes < 1 || mes > 12) return null;
  return { mes, ano };
}

function normalizeValor(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(parsed)) return NaN;
  return parsed;
}

function normalizeFatosList(fatos) {
  if (Array.isArray(fatos)) {
    return fatos
      .map((f) => String(f || '').trim())
      .filter(Boolean);
  }
  if (fatos === undefined || fatos === null) return [];
  return String(fatos)
    .split(/\r?\n|;|\|/)
    .map((f) => f.trim())
    .filter(Boolean);
}

function competenciaString({ mes, ano }) {
  if (!mes || !ano) return '';
  return `${String(mes).padStart(2, '0')}/${ano}`;
}

function buildWhatsappMsisdn(perm) {
  const raw =
    (perm?.telefone_cobranca && String(perm.telefone_cobranca).trim()) ||
    (perm?.telefone && String(perm.telefone).trim()) ||
    '';
  const normalized = normalizeMsisdn(raw);
  if (!normalized) return null;
  return normalized.startsWith('55') ? normalized : `55${normalized}`;
}

router.post(
  '/conciliar',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { data } = req.body || {};

      let alvoISO = null;
      if (data) {
        const parsed = parseDateInput(data);
        if (!parsed) {
          return res.status(400).json({ ok: false, error: 'Data inválida. Use o formato AAAA-MM-DD.' });
        }
        alvoISO = formatISODate(parsed);
      } else {
        const base = new Date();
        if ((process.env.CONCILIAR_BASE_DIA || 'ontem').toLowerCase() !== 'hoje') {
          base.setDate(base.getDate() - 1);
        }
        alvoISO = formatISODate(base);
      }

      if (!alvoISO) {
        return res.status(400).json({ ok: false, error: 'Não foi possível determinar a data para conciliação.' });
      }

      const { executado, resumo } = await executarConciliacaoDia(alvoISO);

      if (!executado) {
        return res.status(409).json({
          ok: false,
          error: 'Já existe uma conciliação em andamento. Aguarde alguns minutos e tente novamente.',
        });
      }

      const totalPagamentos = resumo?.totalPagamentos ?? 0;
      const totalAtualizados = resumo?.totalAtualizados ?? 0;
      const dataConsolidada = resumo?.dataDia || alvoISO;

      return res.json({
        ok: true,
        data: dataConsolidada,
        conciliacao: resumo || { dataDia: dataConsolidada, totalPagamentos, totalAtualizados },
        mensagem: `Conciliação de ${dataConsolidada} finalizada. ${totalAtualizados}/${totalPagamentos} pagamentos vinculados.`,
      });
    } catch (error) {
      console.error('[ADMIN][DAR][conciliar] erro:', error);
      return res.status(500).json({
        ok: false,
        error: `Falha ao executar conciliação: ${error.message || 'erro desconhecido'}`,
      });
    }
  }
);
// helper: pega contribuinte conforme DAR ser de permissionário OU de evento
async function getContribuinteEmitenteForDar(darId) {
  // 1) Busca a DAR
  const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ?`, [darId]);
  if (!dar) throw new Error('DAR não encontrada.');

  // 2) Se for por permissionário, pega do cadastro do permissionário
  if (dar.permissionario_id) {
    const perm = await dbGetAsync(`
      SELECT 
        nome_empresa                                     AS nome,
        COALESCE(NULLIF(TRIM(cnpj), ''), NULLIF(TRIM(cpf), '')) AS doc
      FROM permissionarios
      WHERE id = ?`, [dar.permissionario_id]);

    const nome = (perm?.nome || '').trim() || 'Contribuinte';
    let doc = String(perm?.doc || '').replace(/\D/g, '');
    // fallback: tenta outras colunas comuns, se existirem no schema
    if (!doc) {
      const alt = await dbGetAsync(`
        SELECT 
          COALESCE(NULLIF(TRIM(cnpj), ''), NULLIF(TRIM(cpf), '')) AS doc
        FROM permissionarios WHERE id = ?`, [dar.permissionario_id]);
      doc = String(alt?.doc || '').replace(/\D/g, '');
    }

    if (!(doc.length === 11 || doc.length === 14)) {
      throw new Error('Documento do permissionário ausente ou inválido.');
    }
    const tipo = (doc.length === 11) ? 3 : 4; // 3=CPF, 4=CNPJ

    return {
      codigoTipoInscricao: tipo,
      numeroInscricao: doc,
      nome,
      codigoIbgeMunicipio: 2704302,
      dar,
    };
  }

  // 3) Caso seja DAR de EVENTO, extrai do cliente do evento
  const ev = await dbGetAsync(`
    SELECT 
      COALESCE(NULLIF(TRIM(ce.nome_razao_social), ''), 'Contribuinte') AS nome,
      COALESCE(
        NULLIF(TRIM(ce.documento), ''),
        NULLIF(TRIM(ce.documento_responsavel), '')
      ) AS doc_raw
    FROM DARs_Eventos de
    JOIN Eventos e        ON e.id = de.id_evento
    JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
    WHERE de.id_dar = ?
    LIMIT 1`, [darId]);

  if (!ev) throw new Error('Evento/cliente do evento não encontrado.');

  const nome = ev.nome;
  let doc = String(ev.doc_raw || '').replace(/\D/g, '');

  // última tentativa: buscar direto no cliente, caso tenha ficado vazio
  if (!(doc.length === 11 || doc.length === 14)) {
    const ev2 = await dbGetAsync(`
      SELECT 
        COALESCE(
          NULLIF(TRIM(documento), ''),
          NULLIF(TRIM(documento_responsavel), '')
        ) AS doc2
      FROM Clientes_Eventos
      WHERE id = (SELECT e.id_cliente
                  FROM DARs_Eventos de 
                  JOIN Eventos e ON e.id = de.id_evento
                  WHERE de.id_dar = ? LIMIT 1)`, [darId]);
    doc = String(ev2?.doc2 || '').replace(/\D/g, '');
  }

  if (!(doc.length === 11 || doc.length === 14)) {
    throw new Error('Documento do cliente do evento ausente ou inválido.');
  }
  const tipo = (doc.length === 11) ? 3 : 4;

  return {
    codigoTipoInscricao: tipo,
    numeroInscricao: doc,
    nome,
    codigoIbgeMunicipio: 2704302,
    dar,
  };
}

/**
 * GET /api/admin/dars
 * Lista paginada com filtros (nome/CNPJ, status, mês, ano)
 */
router.get(
  '/',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const search = String(req.query.search || '').trim();
      const status = String(req.query.status || 'todos').trim();
      const mes = String(req.query.mes || 'todos').trim();
      const ano = String(req.query.ano || 'todos').trim();
      const tipo = String(req.query.tipo || '').trim();

      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.max(1, parseInt(req.query.limit || '10', 10));
      const offset = (page - 1) * limit;

      let baseSql = `
        SELECT
          d.id, d.mes_referencia, d.ano_referencia, d.valor,
          d.data_vencimento, d.data_pagamento, d.status,
          d.numero_documento, d.pdf_url,
          p.nome_empresa, p.cnpj, p.tipo
        FROM dars d
        JOIN permissionarios p ON d.permissionario_id = p.id
        WHERE 1=1
      `;
      const params = [];

      if (search) {
        baseSql += ` AND (p.nome_empresa LIKE ? OR p.cnpj LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
      if (status && status !== 'todos') {
        if (['vencido', 'vencida'].includes(status.toLowerCase())) {
          baseSql += ` AND d.status IN (?, ?)`;
          params.push('Vencido', 'Vencida');
        } else {
          baseSql += ` AND d.status = ?`;
          params.push(status);
        }
      }
      if (mes && mes !== 'todos') {
        baseSql += ` AND d.mes_referencia = ?`;
        params.push(mes);
      }
      if (ano && ano !== 'todos') {
        baseSql += ` AND d.ano_referencia = ?`;
        params.push(ano);
      }
      if (tipo) {
        baseSql += ` AND p.tipo = ?`;
        params.push(tipo);
      }

      const countSql = `SELECT COUNT(*) as total FROM (${baseSql}) AS src`;
      const { total } = await dbGetAsync(countSql, params);
      const totalPages = Math.ceil(total / limit);

      const pageSql = `${baseSql} ORDER BY d.ano_referencia DESC, d.mes_referencia DESC, p.nome_empresa LIMIT ? OFFSET ?`;
      const rows = await dbAllAsync(pageSql, [...params, limit, offset]);

      return res.status(200).json({
        dars: rows,
        totalPages,
        currentPage: page,
        totalItems: total
      });
    } catch (err) {
      console.error('[AdminDARs] ERRO GET /api/admin/dars:', err);
      return res.status(500).json({ error: 'Erro ao buscar os DARs.' });
    }
  }
);

router.post(
  '/',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { permissionarioId, tipo, competencia, dataPagamento, valor, fatos } = req.body || {};
      const rawSemJuros =
        req.body?.semJuros ?? req.body?.sem_juros ?? req.body?.semjuros ?? req.body?.semJuro ?? false;
      const semJuros =
        rawSemJuros === true ||
        rawSemJuros === 1 ||
        rawSemJuros === '1' ||
        (typeof rawSemJuros === 'string' && rawSemJuros.toLowerCase() === 'true');
      const permId = Number(permissionarioId);
      if (!Number.isInteger(permId) || permId <= 0) {
        return res.status(400).json({ error: 'permissionarioId inválido.' });
      }

      const tipoLower = String(tipo || '').trim().toLowerCase();
      if (!tipoLower || !['mensalidade', 'advertencia'].includes(tipoLower)) {
        return res.status(400).json({ error: 'Tipo inválido. Utilize Mensalidade ou Advertencia.' });
      }

      const perm = await dbGetAsync('SELECT * FROM permissionarios WHERE id = ?', [permId]);
      if (!perm) {
        return res.status(404).json({ error: 'Permissionário não encontrado.' });
      }

      await ensureAdvertenciaColumn();

      const competenciaInfo = competencia ? parseCompetencia(competencia) : null;
      const fatosList = normalizeFatosList(fatos);
      let mesReferencia = competenciaInfo?.mes || null;
      let anoReferencia = competenciaInfo?.ano || null;
      let dataVencimentoISO = null;
      let valorDar = null;
      let tipoPermissionario = 'Permissionario';
      let advertenciaFatosPersist = null;
      const columns = ['permissionario_id', 'tipo_permissionario', 'valor', 'data_vencimento', 'status'];
      const values = [permId, null, null, null, 'Pendente'];
      let darIdFinal = null;
      let atualizouExistente = false;

      if (tipoLower === 'mensalidade') {
        if (!competenciaInfo) {
          return res.status(400).json({ error: 'Competência inválida. Utilize YYYY-MM ou MM/YYYY.' });
        }
        const tipoPerm = String(perm.tipo || '').trim().toLowerCase();
        if (tipoPerm === 'isento') {
          return res.status(400).json({ error: 'Permissionário isento não pode receber mensalidade.' });
        }
        const aluguel = Number(perm.valor_aluguel || 0);
        if (!(aluguel > 0)) {
          return res.status(400).json({ error: 'Permissionário sem valor de aluguel configurado.' });
        }

        valorDar = normalizeValor(valor, aluguel);
        if (!Number.isFinite(valorDar) || !(valorDar > 0)) {
          return res.status(400).json({ error: 'Valor inválido para a mensalidade.' });
        }

        dataVencimentoISO = getLastBusinessDayISO(competenciaInfo.ano, competenciaInfo.mes);
        tipoPermissionario = 'Permissionario';

        const existente = await dbGetAsync(
          `SELECT id FROM dars WHERE permissionario_id = ? AND mes_referencia = ? AND ano_referencia = ? AND COALESCE(tipo_permissionario,'Permissionario') != 'Advertencia'`,
          [permId, competenciaInfo.mes, competenciaInfo.ano]
        );
        if (existente) {
          if (!semJuros) {
            return res.status(409).json({ error: 'DAR da competência informada já existe.' });
          }
          darIdFinal = existente.id;
          atualizouExistente = true;
        }

        mesReferencia = competenciaInfo.mes;
        anoReferencia = competenciaInfo.ano;
      } else if (tipoLower === 'advertencia') {
        valorDar = normalizeValor(valor, null);
        if (!Number.isFinite(valorDar) || !(valorDar > 0)) {
          return res.status(400).json({ error: 'Valor é obrigatório para advertência.' });
        }
        if (!fatosList.length) {
          return res.status(400).json({ error: 'Fatos são obrigatórios para advertência.' });
        }

        const dataIndicada = dataPagamento ? parseDateInput(dataPagamento) : null;
        if (!dataIndicada) {
          return res.status(400).json({ error: 'Data de pagamento inválida.' });
        }
        if (!isBusinessDay(dataIndicada)) {
          return res.status(400).json({ error: 'Data informada não é dia útil.' });
        }

        dataVencimentoISO = formatISODate(dataIndicada);
        tipoPermissionario = 'Advertencia';
        advertenciaFatosPersist = fatosList.join('\n');

        if (!mesReferencia || !anoReferencia) {
          mesReferencia = dataIndicada.getMonth() + 1;
          anoReferencia = dataIndicada.getFullYear();
        }
      }

      if (semJuros) {
        dataVencimentoISO = isoHojeLocal();
      }

      values[1] = tipoPermissionario;
      values[2] = valorDar;
      values[3] = dataVencimentoISO;

      if (mesReferencia) {
        columns.push('mes_referencia');
        values.push(mesReferencia);
      }
      if (anoReferencia) {
        columns.push('ano_referencia');
        values.push(anoReferencia);
      }
      if (advertenciaFatosPersist) {
        columns.push('advertencia_fatos');
        values.push(advertenciaFatosPersist);
      }

      columns.push('sem_juros');
      values.push(semJuros ? 1 : 0);

      let novoDar;
      if (atualizouExistente) {
        await dbRunAsync(
          `UPDATE dars
              SET tipo_permissionario = ?,
                  valor = ?,
                  data_vencimento = ?,
                  status = 'Pendente',
                  mes_referencia = ?,
                  ano_referencia = ?,
                  sem_juros = 1,
                  numero_documento = NULL,
                  pdf_url = NULL,
                  linha_digitavel = NULL,
                  codigo_barras = NULL,
                  data_emissao = NULL,
                  emitido_por_id = NULL
            WHERE id = ?`,
          [
            tipoPermissionario,
            valorDar,
            dataVencimentoISO,
            mesReferencia || null,
            anoReferencia || null,
            darIdFinal
          ]
        );
        novoDar = await dbGetAsync('SELECT * FROM dars WHERE id = ?', [darIdFinal]);
      } else {
        const placeholders = columns.map(() => '?').join(',');
        const stmt = await dbRunAsync(
          `INSERT INTO dars (${columns.join(',')}) VALUES (${placeholders})`,
          values
        );
        darIdFinal = stmt.lastID;
        novoDar = await dbGetAsync('SELECT * FROM dars WHERE id = ?', [darIdFinal]);
      }

      if (novoDar) {
        const tipoNotificacao = tipoLower === 'advertencia' ? 'advertencia' : 'novo';
        await notificarDarGerado(perm, novoDar, { tipo: tipoNotificacao, fatos: fatosList });

        const msisdn = buildWhatsappMsisdn(perm);
        if (msisdn) {
          try {
            const valorBRL = Number(novoDar.valor || 0).toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            });
            const vencFmt = (() => {
              try {
                return new Date(`${novoDar.data_vencimento}T00:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
              } catch {
                return novoDar.data_vencimento;
              }
            })();
            const competenciaStr = mesReferencia && anoReferencia ? competenciaString({ mes: mesReferencia, ano: anoReferencia }) : '';
            let texto;
            if (tipoLower === 'advertencia') {
              texto = `CIPT - Advertência: emitimos um DAR no valor de R$ ${valorBRL} com vencimento em ${vencFmt}. Consulte o portal do permissionário para detalhes e resposta.`;
            } else {
              texto = `CIPT - Mensalidade: DAR da competência ${competenciaStr} disponível. Valor R$ ${valorBRL} com vencimento em ${vencFmt}. Acesse o portal para emitir o documento.`;
            }
            await whatsappService.sendMessage(msisdn, texto);
          } catch (err) {
            console.error('[AdminDARs] Falha ao enviar WhatsApp:', err?.message || err);
          }
        }
      }

      return res.status(atualizouExistente ? 200 : 201).json({
        dar: {
          id: novoDar?.id || darIdFinal,
          permissionario_id: novoDar?.permissionario_id ?? permId,
          tipo_permissionario: novoDar?.tipo_permissionario ?? tipoPermissionario,
          valor: novoDar?.valor ?? valorDar,
          data_vencimento: novoDar?.data_vencimento ?? dataVencimentoISO,
          status: novoDar?.status ?? 'Pendente',
          mes_referencia: novoDar?.mes_referencia ?? (mesReferencia || null),
          ano_referencia: novoDar?.ano_referencia ?? (anoReferencia || null),
          advertencia_fatos: novoDar?.advertencia_fatos ?? advertenciaFatosPersist,
          sem_juros: novoDar?.sem_juros ?? (semJuros ? 1 : 0)
        }
      });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /api/admin/dars:', err);
      return res.status(500).json({ error: 'Falha ao criar DAR.' });
    }
  }
);

router.post(
  '/:id/baixa-manual',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN']), upload.single('comprovante')],
  async (req, res) => {
    let tempFilePath = null;
    try {
      const darId = Number(req.params.id);
      if (!Number.isInteger(darId) || darId <= 0) {
        return res.status(400).json({ error: 'Identificador de DAR inválido.' });
      }

      const dar = await dbGetAsync('SELECT * FROM dars WHERE id = ?', [darId]);
      if (!dar) {
        return res.status(404).json({ error: 'DAR não encontrado.' });
      }

      const rawDataPagamento =
        req.body?.dataPagamento ??
        req.body?.data_pagamento ??
        req.body?.paymentDate ??
        req.body?.data ??
        null;

      const parsedDataPagamento = parseDateInput(rawDataPagamento);
      if (!parsedDataPagamento) {
        return res.status(400).json({ error: 'Data de pagamento inválida. Utilize o formato AAAA-MM-DD ou DD/MM/AAAA.' });
      }
      const dataPagamentoISO = formatISODate(parsedDataPagamento);

      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) {
        return res.status(400).json({ error: 'Envie o arquivo de comprovante do pagamento.' });
      }

      const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
      if (file.size > MAX_SIZE) {
        return res.status(400).json({ error: 'O comprovante excede o limite de 10 MB.' });
      }

      const allowedMime = new Set(['application/pdf', 'application/x-pdf', 'image/jpeg', 'image/png']);
      const allowedExt = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
      const originalExt = (path.extname(file.originalname || '') || '').toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();

      let finalExt = allowedExt.has(originalExt) ? originalExt : '';
      if (!finalExt) {
        if (mime === 'application/pdf' || mime === 'application/x-pdf') finalExt = '.pdf';
        else if (mime === 'image/jpeg') finalExt = '.jpg';
        else if (mime === 'image/png') finalExt = '.png';
      }

      if (!finalExt || (!allowedExt.has(finalExt) && !allowedMime.has(mime))) {
        return res.status(400).json({ error: 'Formato de arquivo inválido. Utilize PDF, JPG ou PNG.' });
      }

      const docsDir = path.join(process.cwd(), 'public', 'documentos');
      fs.mkdirSync(docsDir, { recursive: true });
      const safeBase = `comprovante_dar_${darId}_${Date.now()}`;
      const fileName = `${safeBase}${finalExt}`;
      const filePath = path.join(docsDir, fileName);
      fs.writeFileSync(filePath, file.buffer);
      tempFilePath = filePath;
      const publicUrl = `/documentos/${fileName}`;

      let tokenDoc = dar.comprovante_token || null;
      let existingDoc = null;
      if (tokenDoc) {
        existingDoc = await dbGetAsync('SELECT id, caminho FROM documentos WHERE token = ?', [tokenDoc]).catch(() => null);
        if (!existingDoc) tokenDoc = null;
      }

      if (!tokenDoc) {
        tokenDoc = await gerarTokenDocumento('DAR_COMPROVANTE_MANUAL', dar.permissionario_id, db);
      }

      const previousPath = existingDoc?.caminho && String(existingDoc.caminho).trim() ? existingDoc.caminho : null;

      await dbRunAsync(
        `UPDATE documentos
            SET tipo = ?,
                caminho = ?,
                pdf_url = ?,
                pdf_public_url = ?,
                status = 'upload_manual',
                permissionario_id = ?,
                evento_id = NULL,
                created_at = datetime('now')
          WHERE token = ?`,
        [
          'DAR_COMPROVANTE_MANUAL',
          filePath,
          filePath,
          publicUrl,
          dar.permissionario_id || null,
          tokenDoc,
        ]
      );

      await dbRunAsync(
        `UPDATE dars
            SET status = 'Pago',
                data_pagamento = ?,
                comprovante_token = ?
          WHERE id = ?`,
        [dataPagamentoISO, tokenDoc, darId]
      );

      if (previousPath && previousPath !== filePath) {
        try {
          if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath);
        } catch (cleanupErr) {
          console.warn('[AdminDARs] Falha ao remover comprovante antigo:', cleanupErr?.message || cleanupErr);
        }
      }

      return res.status(200).json({
        ok: true,
        token: tokenDoc,
        data_pagamento: dataPagamentoISO,
        comprovante_url: publicUrl,
      });
    } catch (err) {
      if (tempFilePath) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {}
      }
      console.error('[AdminDARs] ERRO POST /:id/baixa-manual:', err);
      return res.status(500).json({ error: 'Falha ao registrar baixa manual.' });
    }
  }
);

/**
 * POST /api/admin/dars/:id/enviar-notificacao
 * Envia e-mail (com fallback) para o permissionário daquele DAR.
 */
router.post(
  '/:id/enviar-notificacao',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = req.params.id;

      const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ?`, [darId]);
      if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

      const perm = await dbGetAsync(`SELECT * FROM permissionarios WHERE id = ?`, [dar.permissionario_id]);
      if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

      const ok = await notificarDarGerado(perm, dar, { tipo: 'notificar' });
      if (!ok) {
        return res.status(400).json({
          error: 'Permissionário não possui e-mail de notificação, financeiro ou principal cadastrado.'
        });
      }
      return res.status(200).json({ message: 'E-mail de notificação enviado com sucesso!' });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /:id/enviar-notificacao:', err);
      return res.status(500).json({ error: 'Falha ao enviar o e-mail.' });
    }
  }
);

// POST /api/admin/dars/:id/emitir
router.post(
  '/:id/emitir',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = Number(req.params.id);
      const { codigoTipoInscricao, numeroInscricao, nome, codigoIbgeMunicipio, dar } =
        await getContribuinteEmitenteForDar(darId);

      const hoje = isoHojeLocal();
      const semJuros = Number(dar.sem_juros || 0) === 1;
      const vencOriginal = toISO(dar.data_vencimento);
      const vencAntes = vencOriginal;

      if (!semJuros && vencOriginal && vencOriginal < hoje) {
        const enc = await calcularEncargosAtraso(dar).catch(() => null);
        if (enc) {
          if (enc.valorAtualizado != null) {
            dar.valor = enc.valorAtualizado;
          }
          if (enc.novaDataVencimento) {
            dar.data_vencimento = enc.novaDataVencimento;
          }
        }
      }

      if (semJuros) {
        dar.data_vencimento = hoje;
      }

      const vencAtual = toISO(dar.data_vencimento) || hoje;
      if (vencAtual !== vencAntes) {
        await dbRunAsync(`UPDATE dars SET data_vencimento = ? WHERE id = ?`, [vencAtual, darId]);
        dar.data_vencimento = vencAtual;
      } else if (!dar.data_vencimento) {
        dar.data_vencimento = vencAtual;
      }

      // Doc & tipo saneados
      const doc  = String(numeroInscricao || '').replace(/\D/g, '');
      const tipo = Number(codigoTipoInscricao) || (doc.length === 11 ? 3 : 4);
      if (!(doc.length === 11 || doc.length === 14)) {
        return res.status(400).json({ error: 'Documento inválido (CPF 11 dígitos ou CNPJ 14).' });
      }

      // Competência e vencimento
      const mes  = dar.mes_referencia || Number(String(dar.data_vencimento).slice(5, 7));
      const ano  = dar.ano_referencia || Number(String(dar.data_vencimento).slice(0, 4));
      const venc = String(dar.data_vencimento).slice(0, 10);

      // Receita e observação
      const receitaCodigo = (tipo === 3) ? 20165 : 20164; // ajuste se necessário
      const obsPrefix = dar.permissionario_id ? 'Aluguel CIPT' : 'Evento CIPT';
      const observacao = nome ? `${obsPrefix} - ${nome}` : obsPrefix;

      // Forma 1: payload único
      const payload = {
        contribuinteEmitente: {
          codigoTipoInscricao: tipo,
          numeroInscricao: doc,
          nome,
          codigoIbgeMunicipio
        },
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

      // Forma 2: (contribuinte, guiaLike)
      const contrib = { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio };
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
        console.warn('[SEFAZ][emitir] payload único falhou -> tentando (contrib, guiaLike):', e1?.message);
        try {
          sefaz = await emitirGuiaSefaz(contrib, guiaLike);
        } catch (e2) {
          return res.status(400).json({ error: e2?.message || e1?.message || 'Falha ao emitir a DAR.' });
        }
      }

      if (!sefaz || !sefaz.numeroGuia || !sefaz.pdfBase64) {
        return res.status(502).json({ error: 'Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).' });
      }

      // Token no PDF e persistência
      const tokenDoc = `DAR-${sefaz.numeroGuia}`;
      const pdfComToken = await imprimirTokenEmPdf(sefaz.pdfBase64, tokenDoc);

      await dbRunAsync(`
        UPDATE dars
           SET numero_documento = ?,
               pdf_url          = ?,
               status           = CASE WHEN COALESCE(status,'') IN ('','Pendente','Vencido','Vencida') THEN 'Emitido' ELSE status END,
               data_emissao     = COALESCE(data_emissao, date('now')),
               emitido_por_id   = COALESCE(emitido_por_id, ?)
         WHERE id = ?`,
        [sefaz.numeroGuia, pdfComToken, req.user?.id || null, darId]
      );

      const ld = sefaz.linhaDigitavel || sefaz.linha_digitavel || null;
      const cb = sefaz.codigoBarras  || sefaz.codigo_barras  || null;
      if (ld || cb) {
        await dbRunAsync(
          `UPDATE dars SET linha_digitavel = COALESCE(?, linha_digitavel),
                           codigo_barras  = COALESCE(?, codigo_barras)
           WHERE id = ?`,
          [ld, cb, darId]
        );
      }

      return res.json({ ok: true, numero: sefaz.numeroGuia });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /:id/emitir:', err);
      return res.status(400).json({ error: err.message || 'Falha ao emitir a DAR.' });
    }
  }
);


// POST /api/admin/dars/:id/reemitir  (mesma lógica da /emitir)
router.post(
  '/:id/reemitir',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = Number(req.params.id);
      const { codigoTipoInscricao, numeroInscricao, nome, codigoIbgeMunicipio, dar } =
        await getContribuinteEmitenteForDar(darId);

      if (dar && Object.prototype.hasOwnProperty.call(dar, 'manual') && Number(dar.manual) === 1) {
        return res.status(400).json({ error: 'DAR manual não pode ser reemitida automaticamente.' });
      }

      // Recalcula encargos para DARs atrasadas
      const enc = await calcularEncargosAtraso(dar).catch(() => null);
      if (enc) {
        if (enc.valorAtualizado != null) dar.valor = enc.valorAtualizado;
        if (enc.novaDataVencimento) dar.data_vencimento = enc.novaDataVencimento;
      }

      // ===== dados saneados do contribuinte/DAR =====
const doc  = String(numeroInscricao || '').replace(/\D/g, '');
const tipo = Number(codigoTipoInscricao) || (doc.length === 11 ? 3 : 4);

// LOG útil
console.log('[AdminDARs][emitir]', { darId, tipo, doc, nome, ibge: codigoIbgeMunicipio, perm_id: dar.permissionario_id || null });

// valida doc
if (!(doc.length === 11 || doc.length === 14)) {
  return res.status(400).json({ error: 'Documento inválido (CPF 11 dígitos ou CNPJ 14).' });
}

// competência e vencimento
const mes  = dar.mes_referencia || Number(String(dar.data_vencimento).slice(5, 7));
const ano  = dar.ano_referencia || Number(String(dar.data_vencimento).slice(0, 4));
const venc = String(dar.data_vencimento).slice(0, 10);

// regra simples de receita (ajuste se tiver tabelas)
const receitaCodigo = (tipo === 3) ? 20165 : 20164; // CPF=20165, CNPJ=20164
const obsPrefix = dar.permissionario_id ? 'Aluguel CIPT' : 'Evento CIPT';
const observacao = nome ? `${obsPrefix} - ${nome}` : obsPrefix;

// forma 1: payload único
const payload = {
  contribuinteEmitente: {
    codigoTipoInscricao: tipo,
    numeroInscricao: doc,
    nome,
    codigoIbgeMunicipio
  },
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

// forma 2: (contribuinte, guiaLike) compat
const contrib = { codigoTipoInscricao: tipo, numeroInscricao: doc, nome, codigoIbgeMunicipio };
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
  console.warn('[SEFAZ][emitir] payload único falhou -> tentando (contrib, guiaLike):', e1?.message);
  sefaz = await emitirGuiaSefaz(contrib, guiaLike);
}

// valida retorno
if (!sefaz || !sefaz.numeroGuia || !sefaz.pdfBase64) {
  return res.status(502).json({ error: 'Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).' });
}

// imprime token e persiste
const tokenDoc = `DAR-${sefaz.numeroGuia}`;
const pdfComToken = await imprimirTokenEmPdf(sefaz.pdfBase64, tokenDoc);

await dbRunAsync(
  `UPDATE dars
      SET numero_documento = ?,
          pdf_url          = ?,
          status           = CASE
                                WHEN status = 'Pago Parcialmente' THEN 'Parcialmente Pago'
                                WHEN COALESCE(status,'') IN ('','Pendente','Vencido','Vencida') THEN 'Reemitido'
                                ELSE status
                              END,
          data_emissao     = COALESCE(data_emissao, date('now')),
          emitido_por_id   = COALESCE(emitido_por_id, ?),
          valor            = ?,
          data_vencimento  = ?
    WHERE id = ?`,
  [sefaz.numeroGuia, pdfComToken, req.user?.id || null, dar.valor, dar.data_vencimento, darId]
);

// linha digitável / código de barras (se vierem)
const ld = sefaz.linhaDigitavel || sefaz.linha_digitavel || null;
const cb = sefaz.codigoBarras  || sefaz.codigo_barras  || null;
if (ld || cb) {
  await dbRunAsync(
    `UPDATE dars SET linha_digitavel = COALESCE(?, linha_digitavel),
                     codigo_barras  = COALESCE(?, codigo_barras)
     WHERE id = ?`,
    [ld, cb, darId]
  );
}

return res.json({ ok: true, numero: sefaz.numeroGuia });
    } catch (err) {
      console.error('[AdminDARs] ERRO POST /:id/reemitir:', err);
      return res.status(400).json({ error: err.message || 'Falha ao reemitir a DAR.' });
    }
  }
);


/**
 * GET /api/admin/dars/:id/comprovante
 * Gera comprovante de pagamento da DAR com timbrado e token de verificação.
 */
router.get(
  '/:id/comprovante',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const darId = Number(req.params.id);
      const { buffer, token } = await gerarComprovante(darId, db);
      res.setHeader('X-Document-Token', token);
      res.attachment(`comprovante_dar_${darId}.pdf`);
      res.send(buffer);
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ error: err.message });
      }
      console.error('[AdminDARs] ERRO GET /:id/comprovante:', err);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  }
);

/**
 * GET /api/admin/dars/:id/pdf
 * Retorna o PDF (base64, URL absoluta ou caminho relativo).
 */
router.get(
  '/:id/pdf',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const dar = await dbGetAsync('SELECT * FROM dars WHERE id = ?', [id]);
      if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

      const pdf = dar.pdf_url || dar.link_pdf || '';
      if (!pdf || String(pdf).length < 20) {
        return res.status(404).json({ error: 'PDF indisponível para este DAR.' });
      }

      // base64 direto?
      const isBase64Pdf =
        typeof pdf === 'string' &&
        (/^JVBER/i.test(pdf) || /^data:application\/pdf;base64,/i.test(pdf));
      if (isBase64Pdf) {
        const base64 = String(pdf).replace(/^data:application\/pdf;base64,/i, '');
        const buf = Buffer.from(base64, 'base64');
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="DAR-${dar.numero_documento || id}.pdf"`);
        return res.send(buf);
      }

      // URL absoluta?
      if (/^https?:\/\//i.test(pdf)) {
        return res.redirect(302, pdf);
      }

      // Caminho relativo? (usa base pública, ou stream do disco)
      const rel = String(pdf).replace(/^\/+/, '');
      const base = (process.env.ADMIN_PUBLIC_BASE || '').replace(/\/$/, '');
      if (base) return res.redirect(302, `${base}/${rel}`);

      const fsPath = path.join(process.env.UPLOADS_DIR || 'uploads', rel);
      if (!fs.existsSync(fsPath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
      }
      res.type('application/pdf');
      return fs.createReadStream(fsPath).pipe(res);
    } catch (err) {
      console.error('[AdminDARs] ERRO GET /:id/pdf:', err);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  }
);


module.exports = router;
