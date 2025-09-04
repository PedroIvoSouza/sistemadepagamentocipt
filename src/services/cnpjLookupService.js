const axios = require('axios');

async function fetchCnpjData(cnpj) {
  const digits = String(cnpj || '').replace(/\D/g, '');
  if (!digits) throw new Error('CNPJ inválido');
  try {
    const url = `https://brasilapi.com.br/api/cnpj/v1/${digits}`;
    const { data } = await axios.get(url);
    return {
      razao_social: data.razao_social || data.nome || null,
      nome_fantasia: data.nome_fantasia || null,
      logradouro: data.logradouro || null,
      bairro: data.bairro || null,
      cidade: data.municipio || data.cidade || null,
      uf: data.uf || null,
      cep: data.cep || null
    };
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

module.exports = { fetchCnpjData };
