const axios = require('axios');

/**
 * Emite uma DAR pelo endpoint do bot. Caso a DAR já esteja emitida (409),
 * realiza uma chamada à rota de consulta para obter dados da guia existente.
 *
 * @param {string} baseURL - URL base da API.
 * @param {number} darId - Identificador da DAR.
 * @param {{ msisdn?: string }} [body] - Dados enviados na emissão.
 * @returns {Promise<object>} Resposta da API ou dados da DAR existente.
 */
async function apiEmitDar(baseURL, darId, body = {}) {
  try {
    const res = await axios.post(`${baseURL}/api/bot/dars/${darId}/emit`, body);
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 409) {
      // DAR já emitida: buscar dados existentes
      try {
        const msisdn = body.msisdn;
        const info = await axios.get(`${baseURL}/api/bot/dars/${darId}`, { params: { msisdn } });
        return info.data;
      } catch (consultaErr) {
        // se a consulta falhar, retorna o erro original
        throw err;
      }
    }
    throw err;
  }
}

module.exports = { apiEmitDar };
