// src/services/sefazService.js

const https = require('https');
const fs    = require('fs');
const axios = require('axios');

// Caminho padrão do certificado SEFAZ (homologação)
const CERT_PATH = '/etc/ssl/certs/sefaz_homolog_ca.crt';

/**
 * Emite guia de DAR na SEFAZ.
 *
 * @param {Object} dadosContribuinte
 *   Deve conter ao menos:
 *     - documento: CPF ou CNPJ (string, com ou sem formatação)
 *     - nome_empresa: nome do emitente
 * @param {Object} dadosDar
 *   Deve conter:
 *     - mes_referencia  (number)
 *     - ano_referencia  (number)
 *     - data_vencimento (string no formato 'YYYY-MM-DD')
 *     - valor           (number)
 * @param {Object} opts
 *   @property {string} [campoDocumento='documento']
 *   @property {string} [campoValor='valor']
 *   @property {number} [codigoReceita=20165]
 *   @property {string} [observacaoTemplate]
 *
 * @returns {Promise<Object>} resposta da API SEFAZ
 */
async function emitirGuiaSefaz(dadosContribuinte, dadosDar, opts = {}) {
  const {
    campoDocumento     = 'documento',
    campoValor         = 'valor',
    codigoReceita      = 20165,
    observacaoTemplate = 'Pagamento referente ao aluguel de {nome}'
  } = opts;

  // Limpa apenas dígitos
  const rawDoc = (dadosContribuinte[campoDocumento] || '')
    .toString()
    .replace(/\D/g, '');
  if (![11, 14].includes(rawDoc.length)) {
    throw new Error(
      `Documento inválido em dadosContribuinte['${campoDocumento}']: ${dadosContribuinte[campoDocumento]}`
    );
  }

  // Define tipo de inscrição
  const codigoTipoInscricao = rawDoc.length === 11 ? 1 /* CPF */ : 4 /* CNPJ */;

  // Valor principal
  const valorPrincipal = Number(dadosDar[campoValor]);
  if (isNaN(valorPrincipal) || valorPrincipal <= 0) {
    throw new Error(
      `Valor inválido em dadosDar['${campoValor}']: ${dadosDar[campoValor]}`
    );
  }

  // Monta payload
  const payload = {
    versao: "1.0",
    contribuinteEmitente: {
      codigoTipoInscricao,
      numeroInscricao: rawDoc,
      nome: dadosContribuinte.nome_empresa,
      codigoIbgeMunicipio: 2704302
    },
    receitas: [
      {
        codigo: codigoReceita,
        competencia: {
          mes: dadosDar.mes_referencia,
          ano: dadosDar.ano_referencia
        },
        valorPrincipal,
        dataVencimento: dadosDar.data_vencimento
      }
    ],
    dataLimitePagamento: dadosDar.data_vencimento,
    observacao: observacaoTemplate.replace('{nome}', dadosContribuinte.nome_empresa)
  };

  const apiUrl   = `${process.env.SEFAZ_API_URL_HOM}/api/public/guia/emitir`;
  const appToken = process.env.SEFAZ_APP_TOKEN;

  try {
    console.log('[DEBUG] Verificando arquivo de certificado em', CERT_PATH);
    if (!fs.existsSync(CERT_PATH)) {
      console.error('[ERRO FATAL] Certificado não encontrado:', CERT_PATH);
      throw new Error(`Certificado não encontrado em ${CERT_PATH}`);
    }
    console.log('[DEBUG] Certificado encontrado.');

    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(CERT_PATH),
      rejectUnauthorized: false
    });
    console.log('[DEBUG] Agente HTTPS customizado criado.');

    console.log('[DEBUG] Payload SEFAZ →', JSON.stringify(payload, null, 2));
    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        appToken
      },
      httpsAgent
    });

    console.log('[SUCESSO] Guia emitida pela SEFAZ.');
    return response.data;
  } catch (err) {
    console.error('----------------- ERRO DETALHADO -----------------');
    console.error('Mensagem:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Body:', JSON.stringify(err.response.data, null, 2));
    }
    console.error('----------------------------------------------------');
    throw new Error('Falha na comunicação com a SEFAZ. Veja os logs para detalhes.');
  }
}

module.exports = { emitirGuiaSefaz };