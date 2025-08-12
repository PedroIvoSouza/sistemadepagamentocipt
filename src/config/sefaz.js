// src/config/sefaz.js
module.exports = {
  VERSAO_GUIA: process.env.SEFAZ_VERSAO_GUIA || '1.0', // manual usa "1.0"
  // Código IBGE default do município da UG (Maceió = 2704302)
  CODIGO_IBGE_MUNICIPIO_DEFAULT: process.env.CODIGO_IBGE_MUNICIPIO || '2704302',
  // Código da receita para eventos (sem dígito); ex. 20165 (~ “Fundo de Desenvolvimento…”, vide sua DAR)
  RECEITA_CODIGO_EVENTO: process.env.RECEITA_CODIGO_EVENTO || '20165',
};
