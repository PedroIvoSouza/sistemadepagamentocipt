// Em: src/api/darsRoutes.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const authMiddleware = require('../middleware/authMiddleware');
const { calcularEncargosAtraso } = require('../services/cobrancaService');
const { emitirGuiaSefaz } = require('../services/sefazService');
const onlyDigits = (v='') => String(v).replace(/\D/g,'');
const docType = d => (d.length===14 ? 'CNPJ' : d.length===11 ? 'CPF' : null);

const router = express.Router();
const db = new sqlite3.Database('./sistemacipt.db');

const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// helpers de normalização
const onlyDigits = (v='') => String(v).replace(/\D/g, '');
const docType = d => (d.length === 14 ? 'CNPJ' : d.length === 11 ? 'CPF' : null);

// Rota de listagem (sem alterações)
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
    res.status(200).json(rows);
  });
});

// Rota de recálculo (sem alterações)
router.get('/:id/recalcular', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const darId = req.params.id;
  const sql = `SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`;
  db.get(sql, [darId, userId], async (err, dar) => {
    if (err) return res.status(500).json({ error: 'Erro de banco de dados.' });
    if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });
    try {
      const calculo = await calcularEncargosAtraso(dar);
      res.status(200).json(calculo);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao calcular encargos.' });
    }
  });
});

// ---------------------------
// ROTA DE EMISSÃO (PATCH)
// ---------------------------
router.post('/:id/emitir', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const darId = req.params.id;

  try {
    const dar = await dbGetAsync(`SELECT * FROM dars WHERE id = ? AND permissionario_id = ?`, [darId, userId]);
    if (!dar) return res.status(404).json({ error: 'DAR não encontrado.' });

    // Busca o permissionário
    const userRow = await dbGetAsync(
      `SELECT id, nome_empresa, cnpj, cpf FROM permissionarios WHERE id = ?`,
      [userId]
    );

    if (!userRow) {
      return res.status(404).json({ error: 'Permissionário não encontrado.' });
    }

    // Normaliza documento (CNPJ preferencial, senão CPF)
    const docRaw = userRow.cnpj || userRow.cpf || '';
    const documento = onlyDigits(docRaw);
    const tipoDocumento = docType(documento);

    if (!documento || !tipoDocumento) {
      return res.status(400).json({
        error: `Documento do contribuinte ausente ou inválido (recebido: ${docRaw || 'undefined'})`
      });
    }

    // Monta um objeto de usuário compatível com o emissor da SEFAZ
    const userForSefaz = {
      ...userRow,
      documento,            // <- requerido pelo sefazService
      tipoDocumento,        // 'CNPJ' | 'CPF'
      nomeRazaoSocial: userRow.nome_empresa || userRow.razao_social || 'Contribuinte'
    };

    // Atualiza valores se vencido
    let guiaSource = dar;
    if (dar.status === 'Vencido') {
      const calculo = await calcularEncargosAtraso(dar);
      guiaSource = {
        ...dar,
        valor: calculo.valorAtualizado,
        data_vencimento: calculo.novaDataVencimento
      };
    }

    const sefazResponse = await emitirGuiaSefaz(userForSefaz, guiaSource);
    return res.status(200).json(sefazResponse);

  } catch (error) {
    console.error('Erro na rota /emitir:', error);
    return res.status(500).json({ error: error.message || 'Erro interno do servidor.' });
  }
});

    // enriquece o "user" com o que o serviço espera encontrar
    const contrib = {
