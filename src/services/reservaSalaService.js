const db = require('../database/db');

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const validationError = msg => {
  const err = new Error(msg);
  err.status = 400;
  return err;
};

async function validarSalaECapacidade(salaId, participantes) {
  const sala = await getAsync(
    `SELECT * FROM salas_reuniao WHERE id = ? AND status = 'disponivel'`,
    [salaId]
  );
  if (!sala) {
    const err = validationError('Sala não encontrada ou inativa.');
    err.status = 404;
    throw err;
  }
  if (typeof participantes === 'number' && participantes > sala.capacidade) {
    throw validationError('Capacidade da sala excedida.');
  }
  return sala;
}

function validarHorarios(data, inicio, fim) {
  const inicioDate = new Date(`${data}T${inicio}:00`);
  const fimDate = new Date(`${data}T${fim}:00`);
  if (isNaN(inicioDate) || isNaN(fimDate) || inicioDate >= fimDate) {
    throw validationError('Horários inválidos.');
  }
  if (inicioDate.toDateString() !== fimDate.toDateString()) {
    throw validationError('Reserva deve ocorrer em único dia.');
  }
}

async function verificarConflito(salaId, data, inicio, fim, ignoreId) {
  let sql = `SELECT id FROM reservas_salas
               WHERE sala_id = ? AND data = ?
                 AND NOT (? >= hora_fim OR ? <= hora_inicio)`;
  const params = [salaId, data, inicio, fim];
  if (ignoreId) {
    sql += ' AND id <> ?';
    params.push(ignoreId);
  }
  const conflito = await getAsync(sql, params);
  if (conflito) throw validationError('Horário indisponível para a sala.');
}

module.exports = {
  validarSalaECapacidade,
  validarHorarios,
  verificarConflito,
};
