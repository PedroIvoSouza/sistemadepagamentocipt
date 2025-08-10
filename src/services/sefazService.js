// Em: src/services/sefazService.js
const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shouldRetry = (status, code) => {
  if (!status) return ['ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code);
  return status >= 500 || status === 429;
};

/**
 * Monta e emite a guia na SEFAZ/AL conforme manual v2.1.0 (Jun/2025).
 * Necessário header 'appToken' em todas as requisições.
 *
 * Campos obrigatórios de emissão (resumo):
 * - versao
 * - contribuinteEmitente: codigoTipoInscricao, numeroInscricao, nome, codigoIbgeMunicipio
 * - receitas[]: codigo, competencia.{mes, ano}, valorPrincipal, dataVencimento
 * - dataLimitePagamento
 * - retorno: numeroGuia, pdfBase64
 */
async function emitirGuiaSefaz(userForSefaz, dar) {
  const baseURL = (process.env.SEFAZ_URL || '').replace(/\/+$/, '');
  const endpoint = process.env.SEFAZ_EMISSAO_PATH || '/api/public/guia/emitir';
  const url = baseURL + endpoint;

  const maxRetries = Number(process.env.SEFAZ_MAX_RETRIES || 3);
  const baseDelay = Number(process.env.SEFAZ_RETRY_BASE_MS || 1000);

  // Normaliza competência e datas
  const mes = Number(dar.mes_referencia);
  const ano = Number(dar.ano_referencia);
  const valorPrincipal = Number(dar.valor);
  const dataVenc = String(dar.data_vencimento || '').slice(0, 10);

  // Quando vencido (ou data inválida), empurra vencimento para hoje+2
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  let dataVencimento = dataVenc;
  const parsed = new Date(dataVenc);
  if (!dataVenc || isNaN(parsed.getTime()) || parsed < hoje) {
    const d = new Date(); d.setDate(d.getDate() + 2);
    dataVencimento = d.toISOString().slice(0, 10);
  }

  // codigoTipoInscricao: 4 = CNPJ (manual)  :contentReference[oaicite:11]{index=11}
  const payload = {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: 4, // CNPJ
      numeroInscricao: userForSefaz.documento, // 14 dígitos
      nome: userForSefaz.nomeRazaoSocial,
      codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO || 2704302),
      // numeroCep e descricaoEndereco são opcionais segundo revisão 2025
    },
    receitas: [
      {
        codigo: Number(dar.codigo_receita || process.env.CODIGO_RECEITA_PADRAO || 20165),
        competencia: { mes, ano }, // inteiros
        valorPrincipal,
        dataVencimento: dataVencimento,
        // Se a receita exigir documento de origem, preencha abaixo (ver /receita/consultar)
        // codigoTipoDocumentoOrigem: ...,
        // numeroDocumentoOrigem: ...,
      }
    ],
    dataLimitePagamento: dataVencimento,
    observacao: `Pagamento referente ao aluguel de ${userForSefaz.nomeRazaoSocial}`
  };

  // Logs úteis para debug
  console.debug('[DEBUG] Payload SEFAZ →', JSON.stringify(payload, null, 2));

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await axios.post(url, payload, {
        timeout: Number(process.env.SEFAZ_TIMEOUT_MS || 15000),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'appToken': process.env.SEFAZ_APP_TOKEN || ''
        },
        validateStatus: () => true
      });

      console.log('[SEFAZ] status:', resp.status, 'tempo(ms):', Date.now() - t0);

      if (resp.status >= 200 && resp.status < 300) {
        // Esperado: { numeroGuia, pdfBase64 }  :contentReference[oaicite:12]{index=12}
        return resp.data;
      }

      // Erro de backend da SEFAZ (ex.: Load balancer sem instâncias)
      console.error('----------------- ERRO DETALHADO -----------------');
      console.error('Mensagem:', `Request failed with status code ${resp.status}`);
      console.error('Status:', resp.status);
      try { console.error('Body:', JSON.stringify(resp.data, null, 2)); }
      catch { console.error('Body (raw):', resp.data); }
      console.error('----------------------------------------------------');

      const msg = String(resp?.data?.message || '');
      if (msg.includes('Load balancer does not have available server')) {
        lastErr = new Error('SEFAZ indisponível (balanceador sem instâncias).');
      } else {
        lastErr = new Error(`SEFAZ respondeu ${resp.status}: ${JSON.stringify(resp.data)}`);
      }

      if (shouldRetry(resp.status, null) && attempt < maxRetries) {
        const wait = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`[SEFAZ] retry ${attempt}/${maxRetries - 1} em ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      throw lastErr;

    } catch (err) {
      console.error('[SEFAZ] falha:', {
        message: err.message,
        code: err.code,
        status: err.response?.status
      });
      lastErr = err;

      if (shouldRetry(err.response?.status, err.code) && attempt < maxRetries) {
        const wait = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`[SEFAZ] retry ${attempt}/${maxRetries - 1} em ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr || new Error('Falha desconhecida ao emitir DAR na SEFAZ.');
}

module.exports = { emitirGuiaSefaz };
