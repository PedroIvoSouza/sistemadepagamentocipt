// Em: src/api/darsRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const authMiddleware = require('../middleware/authMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { emitirGuiaSefaz } = require('../services/sefazService');

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

const dbGetAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

// Helpers
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

// YYYY-MM-DD no horário local (evita “voltar 1 dia” pelo UTC)
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

// Payload para SEFAZ
function buildSefazPayloadPermissionario({ perm, darLike }) {
  const cnpj = onlyDigits(perm.cnpj || '');
  if (cnpj.length !== 14) throw new Error(`CNPJ inválido para o permissionário: ${perm.cnpj || 'vazio'}`);

  // vencimento do DAR
  let dataVenc = toISO(darLike.data_vencimento);
  if (!dataVenc) throw new Error(`Data de vencimento inválida: ${darLike.data_vencimento}`);

  // hoje local e limite >= hoje
  const hoje = isoHojeLocal();
  const dataLimitePagamento = dataVenc < hoje ? hoje : dataVenc;

  // competência: preferir a referência do DAR, senão cair no mês/ano do vencimento
  let compMes = Number(darLike.mes_referencia);
  let compAno = Number(darLike.ano_referencia);
  if (!compMes || !compAno) {
    const [yyyy, mm] = dataVenc.split('-');
    compMes = compMes || Number(mm);
    compAno = compAno || Number(yyyy);
  }

  const codigoIbge = Number(process.env.COD_IBGE_MUNICIPIO || 0);
  const receitaCod = Number(process.env.RECEITA_CODIGO_PERMISSIONARIO || 0);
  if (!codigoIbge) throw new Error('COD_IBGE_MUNICIPIO não configurado (.env).');
  if (!receitaCod) throw new Error('RECEITA_CODIGO_PERMISSIONARIO não configurado (.env).');

  // Endereço/CEP — fallbacks caso não existam colunas no DB
  const descricaoEndereco =
    (perm.endereco && String(perm.endereco).trim()) ||
    (process.env.ENDERECO_PADRAO || 'R. Barão de Jaraguá, 590 - Jaraguá, Maceió/AL');
  const numeroCep =
    onlyDigits(perm.cep || '') ||
    onlyDigits(process.env.CEP_PADRAO || '57020000');

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
    dataLimitePagamento, // **sempre >= hoje**
    observacao: `Aluguel CIPT - ${String(perm.nome_empresa || '').slice(0, 60)}`
  };
}

// -------------------- Listagem --------------------
router.get('/', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { ano, status } = req.query;

  let sql = `SELECT * FROM dars WHERE permissionario_id = ?`;
  const params = [userId];

  if (ano && ano !== 'todos') {
    sql += ` AND ano_referencia = ?`;
    params.push(ano);
  }
  if (status && status !== 'todos') {
    sql += ` AND status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY ano_referencia DESC, mes_referencia DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
    return res.status(200).json(rows);
  });
});

// -------------------- Recalcular --------------------
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

// -------------------- Preview --------------------
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
      `SELECT id, nome_empresa, cnpj FROM permissionarios WHERE id = ?`,
      [userId]
    );
    if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

    // Se vencido, simula com valor/data atualizados
    let guiaSource = { ...dar };
    if (dar.status === 'Vencido') {
      const calculo = await calcularEncargosAtraso(dar);
      guiaSource.valor = calculo.valorAtualizado;
      guiaSource.data_vencimento = calculo.novaDataVencimento || isoHojeLocal();
      if (toISO(guiaSource.data_vencimento) < isoHojeLocal()) {
        guiaSource.data_vencimento = isoHojeLocal();
      }
    } else {
      // Se por acaso o DB tiver um vencimento no passado, evita erro de limite
      if (toISO(guiaSource.data_vencimento) < isoHojeLocal()) {
        guiaSource.data_vencimento = isoHojeLocal();
      }
    }

    const payload = buildSefazPayloadPermissionario({ perm, darLike: guiaSource });
    return res.status(200).json({ payloadPreview: payload });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Erro ao montar preview.' });
  }
});

// -------------------- Emitir --------------------
router.post('/:id/emitir', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const darId = req.params.id;
  const debug = String(req.query.debug || '').trim() === '1';

  try {
    const dar = await dbGetAsync(
      `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`,
      [darId, userId]
    );
    if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

    const perm = await dbGetAsync(
      `SELECT id, nome_empresa, cnpj FROM permissionarios WHERE id = ?`,
      [userId]
    );
    if (!perm) return res.status(404).json({ error: 'Permissionário não encontrado.' });

    // Ajusta valor/data caso vencido (e garante vencimento >= hoje)
    let guiaSource = { ...dar };
    if (dar.status === 'Vencido') {
      const calculo = await calcularEncargosAtraso(dar);
      guiaSource.valor = calculo.valorAtualizado;
      guiaSource.data_vencimento = calculo.novaDataVencimento || isoHojeLocal();
    }
    if (toISO(guiaSource.data_vencimento) < isoHojeLocal()) {
      guiaSource.data_vencimento = isoHojeLocal();
    }

    // Payload final para a SEFAZ (com dataLimitePagamento >= hoje)
    const payload = buildSefazPayloadPermissionario({ perm, darLike: guiaSource });

    // Chama SEFAZ (ajuste o sefazService para aceitar o payload direto)
    const sefazResponse = await emitirGuiaSefaz(payload);
    // Esperado: { numeroGuia, pdfBase64, ... }
    if (!sefazResponse || !sefazResponse.numeroGuia || !sefazResponse.pdfBase64) {
      throw new Error('Retorno da SEFAZ incompleto.');
    }

    // Atualiza DAR no banco
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
        [sefazResponse.numeroGuia, sefazResponse.pdfBase64, darId],
        function (err) { return err ? reject(err) : resolve(this); }
      );
    });

    return res
      .status(200)
      .json(debug ? { ...sefazResponse, _payloadDebug: payload } : sefazResponse);
  } catch (error) {
    console.error('Erro na rota /emitir:', error);
    const isUnavailable =
      /indispon[ií]vel|Load balancer|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(
        error.message || ''
      );
    const status = isUnavailable ? 503 : 500;
    return res.status(status).json({ error: error.message || 'Erro interno do servidor.' });
  }
});

module.exports = router;