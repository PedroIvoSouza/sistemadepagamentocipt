const db = require('../database/db');

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

async function log(reservaId, acao, detalhes) {
  const detalhesStr = detalhes ? JSON.stringify(detalhes) : null;
  await runAsync(
    `INSERT INTO reservas_audit (reserva_id, acao, detalhes) VALUES (?, ?, ?)`,
    [reservaId, acao, detalhesStr]
  );
}

function logCriacao(reservaId, detalhes) {
  return log(reservaId, 'CRIACAO', detalhes);
}

function logAtualizacao(reservaId, detalhes) {
  return log(reservaId, 'ATUALIZACAO', detalhes);
}

function logCancelamento(reservaId, detalhes) {
  return log(reservaId, 'CANCELAMENTO', detalhes);
}

function logCheckin(reservaId, detalhes) {
  return log(reservaId, 'CHECKIN', detalhes);
}

module.exports = {
  logCriacao,
  logAtualizacao,
  logCancelamento,
  logCheckin,
};
