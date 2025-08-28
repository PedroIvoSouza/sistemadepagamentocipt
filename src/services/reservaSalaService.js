const db = require('../database/db');

/**
 * Verifica se há conflito de horário para uma sala específica.
 * Retorna true caso exista alguma reserva sobreposta ao intervalo informado.
 *
 * @param {number} salaId       Identificador da sala
 * @param {string} inicioISO    Data/hora de início da reserva (ISO)
 * @param {string} fimISO       Data/hora de término da reserva (ISO)
 * @param {number} [ignorarId]  Reserva a desconsiderar na verificação
 * @returns {Promise<boolean>}  true se houver conflito
 */
function verificarConflitoHorario(salaId, inicioISO, fimISO, ignorarId = null) {
  return new Promise((resolve, reject) => {
    let sql = `
      SELECT COUNT(*) AS total
      FROM reservas
      WHERE sala_id = ?
        AND status <> 'cancelada'
        AND inicio < ?
        AND fim > ?
    `;
    const params = [salaId, fimISO, inicioISO];
    if (ignorarId) {
      sql += ' AND id <> ?';
      params.push(ignorarId);
    }
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row.total > 0);
    });
  });
}

/**
 * Checa se a reserva pode ser cancelada considerando antecedência mínima.
 *
 * @param {object} reserva            Objeto da reserva com propriedade "inicio" em ISO string
 * @param {number} antecedenciaMin    Antecedência mínima em horas (padrão: 24)
 * @returns {boolean}                 true se pode cancelar
 */
function checarAntecedenciaCancelamento(reserva, antecedenciaMin = 24) {
  const agora = new Date();
  const inicio = new Date(reserva.inicio);
  const diffHoras = (inicio - agora) / 36e5; // milissegundos para horas
  return diffHoras >= antecedenciaMin;
}

/**
 * Registra informação na tabela de auditoria das reservas.
 *
 * @param {number} reservaId  Identificador da reserva
 * @param {string} acao       Ação executada
 * @param {string} [detalhes] Detalhes adicionais
 */
function registrarAuditoria(reservaId, acao, detalhes = null) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO reservas_audit (reserva_id, acao, detalhes)
      VALUES (?, ?, ?)
    `;
    db.run(sql, [reservaId, acao, detalhes], err => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Marca automaticamente como "não compareceu" todas as reservas confirmadas
 * cujo horário de início já passou.
 *
 * @returns {Promise<number>} Quantidade de reservas atualizadas
 */
async function marcarNoShowAutomatico() {
  const agora = new Date().toISOString();
  const reservas = await new Promise((resolve, reject) => {
    db.all(
      `SELECT id FROM reservas WHERE status = 'confirmada' AND inicio < ?`,
      [agora],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });

  let count = 0;
  for (const { id } of reservas) {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE reservas SET status = 'nao_compareceu', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`,
        [id],
        err => (err ? reject(err) : resolve())
      );
    });
    await registrarAuditoria(id, 'no-show', 'Marcado automaticamente como não compareceu');
    count++;
  }
  return count;
}

module.exports = {
  verificarConflitoHorario,
  checarAntecedenciaCancelamento,
  marcarNoShowAutomatico,
  registrarAuditoria,
};

