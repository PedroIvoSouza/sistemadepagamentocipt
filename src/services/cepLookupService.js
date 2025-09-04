const axios = require('axios');

async function fetchCepAddress(cep) {
  const digits = String(cep || '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(digits)) {
    throw new Error('CEP inválido');
  }
  try {
    const url = `https://viacep.com.br/ws/${digits}/json/`;
    const { data } = await axios.get(url);
    if (data.erro) {
      throw new Error('CEP não encontrado');
    }
    return {
      logradouro: data.logradouro || null,
      bairro: data.bairro || null,
      localidade: data.localidade || data.cidade || null,
      uf: data.uf || null
    };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      throw new Error('CEP não encontrado');
    }
    if (err.response && err.response.status === 400) {
      throw new Error('CEP inválido');
    }
    throw err;
  }
}

module.exports = { fetchCepAddress };

