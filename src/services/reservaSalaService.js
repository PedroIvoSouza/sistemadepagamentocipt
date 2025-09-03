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
  try {
    let sql = `SELECT id FROM reservas_salas
               WHERE sala_id = ? AND data = ?
                 AND status <> 'cancelada'
                 AND NOT (? >= hora_fim OR ? <= hora_inicio)`;
    const params = [salaId, data, inicio, fim];
    if (ignoreId) {
      sql += ' AND id <> ?';
      params.push(ignoreId);
    }
    const conflito = await getAsync(sql, params);
    if (conflito) throw validationError('Horário indisponível para a sala.');
  } catch (e) {
    if (
      e.code === 'SQLITE_CONSTRAINT' &&
      /UNIQUE constraint failed: reservas_salas/.test(e.message || '')
    ) {
      throw validationError('Horário indisponível para a sala.');
    }
    throw e;
  }
}

async function verificarDiasConsecutivos(permissionarioId, salaId, data) {
  const baseDate = new Date(`${data}T00:00:00`);
  if (isNaN(baseDate)) throw validationError('Data inválida.');
  const prev = new Date(baseDate);
  prev.setDate(baseDate.getDate() - 1);
  const next = new Date(baseDate);
  next.setDate(baseDate.getDate() + 1);
  const prevStr = prev.toISOString().slice(0, 10);
  const nextStr = next.toISOString().slice(0, 10);
  const sql = `SELECT id FROM reservas_salas WHERE permissionario_id = ? AND sala_id = ? AND data IN (?, ?)`;
  const conflito = await getAsync(sql, [permissionarioId, salaId, prevStr, nextStr]);
  if (conflito) {
    throw validationError('Não é permitido reservar sala em dias consecutivos.');
  }
}

async function verificarClienteInapto(permissionarioId) {
  try {
    const row = await getAsync(
      `SELECT inapto_ate FROM Clientes_Eventos WHERE id = ?`,
      [permissionarioId]
    );
    if (row && row.inapto_ate) {
      const ate = new Date(row.inapto_ate);
      if (!isNaN(ate) && ate > new Date()) {
        throw validationError(`Cliente inapto até ${row.inapto_ate}`);
      }
    }
  } catch (e) {
    if (/(no such table)/i.test(e.message || '')) return;
    throw e;
  }
}

module.exports = {
  validarSalaECapacidade,
  validarHorarios,
  verificarConflito,
  verificarDiasConsecutivos,
  verificarClienteInapto,
};
