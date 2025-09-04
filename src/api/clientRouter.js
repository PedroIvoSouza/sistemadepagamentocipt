const express = require('express');
const clientRouter = express.Router(); // <-- isso garante que ele fique “azulzinho”
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const jwt = require('jsonwebtoken');


// Tudo aqui exige token de cliente de eventos
clientRouter.use(authMiddleware, authorizeRole(['CLIENTE_EVENTO']));

// Perfil
clientRouter.get('/me', (req, res) => {
  const id = req.user.id;
  const sql = `SELECT id, nome_razao_social, tipo_pessoa, documento, email, telefone, cep, logradouro, numero, complemento, bairro, cidade, uf
               FROM Clientes_Eventos WHERE id = ?`;
  db.get(sql, [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro de banco.' });
    if (!row) return res.status(404).json({ error: 'Não encontrado.' });
    res.json(row);
  });
});

// Dashboard
clientRouter.get('/dashboard-stats', (req, res) => {
  const id = req.user.id;
  const sql = `
    SELECT
      SUM(CASE WHEN d.status = 'Pendente' THEN 1 ELSE 0 END) AS pendentes,
      SUM(CASE WHEN d.status = 'Vencido'  THEN 1 ELSE 0 END) AS vencidos,
      SUM(CASE WHEN d.status = 'Pago'     THEN 1 ELSE 0 END) AS pagos,
      ROUND(SUM(CASE WHEN d.status IN ('Pendente','Vencido') THEN d.valor ELSE 0 END), 2) AS totalDevido
    FROM dars d
    JOIN DARs_Eventos de ON de.id_dar = d.id
    JOIN Eventos e       ON e.id = de.id_evento
    WHERE e.id_cliente = ?
  `;
  db.get(sql, [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro de banco.' });
    res.json({
      darsPendentes: row?.pendentes || 0,
      darsVencidos:  row?.vencidos  || 0,
      darsPagos:     row?.pagos     || 0,
      valorTotalDevido: row?.totalDevido || 0
    });
  });
});

// Meus eventos
clientRouter.get('/eventos', (req, res) => {
  const id = req.user.id;
  const sql = `
    SELECT e.id, e.nome_evento, e.status, e.total_diarias, e.valor_final, e.datas_evento, e.data_vigencia_final,
           e.emprestimo_tvs, e.emprestimo_caixas_som, e.emprestimo_microfones
    FROM Eventos e
    WHERE e.id_cliente = ?
    ORDER BY e.id DESC
  `;
  db.all(sql, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro de banco.' });
    res.json(rows);
  });
});

// Minhas DARs (de eventos)
clientRouter.get('/dars', (req, res) => {
  const id = req.user.id;
  const sql = `
    SELECT d.id, d.valor, d.mes_referencia, d.ano_referencia, d.data_vencimento, d.status,
           d.numero_documento, d.linha_digitavel, d.codigo_barras, d.pdf_url,
           de.numero_parcela, de.valor_parcela, e.nome_evento
    FROM dars d
    JOIN DARs_Eventos de ON de.id_dar = d.id
    JOIN Eventos e       ON e.id = de.id_evento
    WHERE e.id_cliente = ?
    ORDER BY d.data_vencimento DESC, d.id DESC
  `;
  db.all(sql, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro de banco.' });
    res.json(rows);
  });
});

// Rota protegida: retornar dados do cliente autenticado
clientRouter.get('/me', (req, res) => {
  const clienteId = req.user?.id;

  if (!clienteId) return res.status(401).json({ error: 'Não autenticado.' });

  const sql = `SELECT id, nome_razao_social, documento, email FROM Clientes_Eventos WHERE id = ?`;
  db.get(sql, [clienteId], (err, row) => {
    if (err) {
      console.error("Erro ao buscar cliente logado:", err.message);
      return res.status(500).json({ error: 'Erro interno no servidor.' });
    }
    if (!row) return res.status(404).json({ error: 'Cliente não encontrado.' });

    res.json({
      id: row.id,
      nome: row.nome_razao_social,
      cnpj: row.documento,
      eventos: [], // substitua com dados reais se desejar
      dars: [],
      valor_em_aberto: 0
    });
  });
});


module.exports = { adminRoutes: adminRouter, publicRoutes: publicRouter, clientRoutes: clientRouter };