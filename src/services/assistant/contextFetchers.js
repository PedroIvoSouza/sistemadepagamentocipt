const db = require('../../database/db');

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function getPermissionarioContext(permissionarioId) {
  const rawProfile = await dbGet('SELECT * FROM permissionarios WHERE id = ?', [permissionarioId]);
  if (!rawProfile) {
    return { type: 'permissionario', missing: true };
  }

  const stats =
    (await dbGet(
      `SELECT
          SUM(CASE WHEN status != 'Pago' AND DATE(data_vencimento) >= DATE('now','localtime') THEN 1 ELSE 0 END) AS pendentes,
          SUM(CASE WHEN status != 'Pago' AND DATE(data_vencimento) < DATE('now','localtime') THEN 1 ELSE 0 END) AS vencidas,
          ROUND(SUM(CASE WHEN status != 'Pago' THEN valor ELSE 0 END), 2) AS valor_aberto
        FROM dars WHERE permissionario_id = ?`,
      [permissionarioId]
    )) || { pendentes: 0, vencidas: 0, valor_aberto: 0 };

  const proximasDars = await dbAll(
    `SELECT id, mes_referencia, ano_referencia, data_vencimento, status, valor
       FROM dars
       WHERE permissionario_id = ?
       ORDER BY DATE(data_vencimento) ASC
       LIMIT 5`,
    [permissionarioId]
  );

  return {
    type: 'permissionario',
    profile: {
      id: rawProfile.id,
      nome: rawProfile.nome_empresa || rawProfile.nome || 'Permissionário',
      nome_empresa: rawProfile.nome_empresa,
      cnpj: rawProfile.cnpj,
      email: rawProfile.email,
      email_financeiro: rawProfile.email_financeiro,
      email_notificacao: rawProfile.email_notificacao,
      telefone: rawProfile.telefone_cobranca || rawProfile.telefone,
      numero_sala: rawProfile.numero_sala,
      valor_aluguel: rawProfile.valor_aluguel,
    },
    stats: {
      darsPendentes: Number(stats.pendentes || 0),
      darsVencidas: Number(stats.vencidas || 0),
      valorAberto: Number(stats.valor_aberto || 0),
    },
    proximasDars,
  };
}

async function getAdminContext(adminId) {
  const admin = await dbGet('SELECT id, nome, email, role FROM administradores WHERE id = ?', [adminId]);
  if (!admin) {
    return { type: 'admin', missing: true };
  }

  const totals =
    (await dbGet(
      `SELECT
          (SELECT COUNT(*) FROM permissionarios) AS total_permissionarios,
          (SELECT COUNT(*) FROM dars WHERE status != 'Pago') AS dars_em_aberto,
          (SELECT COUNT(*) FROM Eventos) AS total_eventos,
          (SELECT COUNT(*) FROM Clientes_Eventos) AS total_clientes_eventos
        `
    )) || {};

  return {
    type: 'admin',
    profile: admin,
    stats: {
      permissionarios: Number(totals.total_permissionarios || 0),
      darsAbertas: Number(totals.dars_em_aberto || 0),
      eventos: Number(totals.total_eventos || 0),
      clientesEvento: Number(totals.total_clientes_eventos || 0),
    },
  };
}

async function getClienteEventoContext(clienteId) {
  const cliente = await dbGet('SELECT * FROM Clientes_Eventos WHERE id = ?', [clienteId]);
  if (!cliente) {
    return { type: 'cliente_evento', missing: true };
  }

  const stats =
    (await dbGet(
      `SELECT
          SUM(CASE WHEN d.status != 'Pago' AND DATE(d.data_vencimento) >= DATE('now','localtime') THEN 1 ELSE 0 END) AS pendentes,
          SUM(CASE WHEN d.status != 'Pago' AND DATE(d.data_vencimento) < DATE('now','localtime') THEN 1 ELSE 0 END) AS vencidas,
          ROUND(SUM(CASE WHEN d.status != 'Pago' THEN d.valor ELSE 0 END), 2) AS valor_aberto
        FROM dars d
        JOIN DARs_Eventos de ON de.id_dar = d.id
        JOIN Eventos e ON e.id = de.id_evento
        WHERE e.id_cliente = ?`,
      [clienteId]
    )) || { pendentes: 0, vencidas: 0, valor_aberto: 0 };

  const eventosRecentes = await dbAll(
    `SELECT id, nome_evento, status, data_vigencia_final
       FROM Eventos
       WHERE id_cliente = ?
       ORDER BY id DESC
       LIMIT 5`,
    [clienteId]
  );

  return {
    type: 'cliente_evento',
    profile: {
      id: cliente.id,
      nome: cliente.nome_razao_social,
      documento: cliente.documento,
      email: cliente.email,
      telefone: cliente.telefone,
    },
    stats: {
      darsPendentes: Number(stats.pendentes || 0),
      darsVencidas: Number(stats.vencidas || 0),
      valorAberto: Number(stats.valor_aberto || 0),
    },
    eventosRecentes,
  };
}

module.exports = {
  getPermissionarioContext,
  getAdminContext,
  getClienteEventoContext,
  dbGet,
  dbAll,
};
