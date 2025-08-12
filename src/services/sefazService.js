// Em: src/services/sefazService.js

const https = require('https');
const axios = require('axios');

/**
 * Envia uma requisição de emissão de guia para a API da SEFAZ.
 * * @param {object} payload O corpo da requisição, formatado exatamente como no manual da SEFAZ.
 * @returns {Promise<object>} A resposta da API da SEFAZ.
 * @throws {Error} Lança um erro se a comunicação falhar ou a SEFAZ retornar um erro.
 */
async function emitirGuiaSefaz(payload) {
  // 1. Validação de entrada básica
  if (!payload || !payload.contribuinteEmitente || !Array.isArray(payload.receitas) || payload.receitas.length === 0) {
    throw new Error('Payload para a SEFAZ está malformado ou incompleto.');
  }

  // 2. Configurações da API a partir do .env
  const mode = (process.env.SEFAZ_MODE || 'hom').toLowerCase();
  const baseURL = mode === 'prod'
    ? process.env.SEFAZ_API_URL_PROD
    : process.env.SEFAZ_API_URL_HOM; // Ex: https://acessosefaz.hom.sefaz.al.gov.br/sfz-arrecadacao-guia-api

  const url = `${baseURL}/api/public/guia/emitir`;
  const appToken = process.env.SEFAZ_APP_TOKEN;

  if (!baseURL || !appToken) {
    throw new Error('As variáveis de ambiente da SEFAZ (URL e TOKEN) não estão configuradas.');
  }

  // 3. Configuração do Agente HTTPS (para certificados e modo inseguro)
  const insecure = String(process.env.SEFAZ_TLS_INSECURE || 'false').toLowerCase() === 'true';
  const httpsAgent = new https.Agent({
    rejectUnauthorized: !insecure // `true` por padrão, `false` se insecure=true
  });
  if (insecure) {
    console.warn('[SEFAZ][TLS] MODO INSEGURO ATIVADO (rejectUnauthorized=false). Use apenas para testes.');
  }

  // 4. Configurações de timeout e retentativas
  const timeout = Number(process.env.SEFAZ_TIMEOUT_MS || 20000); // 20 segundos

  console.log(`[SEFAZ] Enviando para ${url}`);
  console.log('[SEFAZ] Payload:', JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(url, payload, {
      timeout,
      httpsAgent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'appToken': appToken,
      },
    });

    // A API da SEFAZ pode retornar 2xx mesmo com erros no corpo, então checamos o conteúdo.
    if (response.status >= 200 && response.status < 300) {
      console.log('[SEFAZ] Resposta recebida com sucesso:', response.data);
      return response.data; // Ex: { numeroGuia: 11351135, pdfBase64: "JVBER..." }
    } else {
        // Trata outros casos de sucesso com corpo de erro
        const errorMsg = `SEFAZ retornou status ${response.status}. Corpo: ${JSON.stringify(response.data)}`;
        throw new Error(errorMsg);
    }
  } catch (error) {
    console.error('----------------- ERRO NA CHAMADA AXIOS -----------------');
    if (error.response) {
      // O servidor respondeu com um status fora da faixa 2xx
      console.error('Status:', error.response.status);
      console.error('Headers:', error.response.headers);
      console.error('Corpo do erro:', JSON.stringify(error.response.data, null, 2));
      
      const friendlyMessage = error.response.data?.mensagem || 'Erro desconhecido da SEFAZ.';
      throw new Error(`Erro ${error.response.status}: ${friendlyMessage}`);

    } else if (error.request) {
      // A requisição foi feita mas nenhuma resposta foi recebida
      console.error('A requisição para a SEFAZ não obteve resposta.', error.message);
      throw new Error('A SEFAZ não respondeu. Verifique a conexão (VPN) e a disponibilidade do serviço.');
    } else {
      // Algo aconteceu ao configurar a requisição
      console.error('Erro ao configurar a requisição para a SEFAZ:', error.message);
      throw new Error(`Erro de configuração: ${error.message}`);
    }
  }
}

module.exports = { emitirGuiaSefaz };