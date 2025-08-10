// src/services/sefazService.js
const axios = require('axios');
const https = require('https');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shouldRetry = (status, code) => {
  if (!status) return ['ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code);
  return status >= 500 || status === 429;
};

function resolveBaseUrl() {
  const mode = (process.env.SEFAZ_MODE || 'hom').toLowerCase();
  const hom = (process.env.SEFAZ_API_URL_HOM || '').replace(/\/+$/, '');
  const prod = (process.env.SEFAZ_API_URL_PROD || '').replace(/\/+$/, '');
  return mode === 'prod' ? prod : hom;
}

function buildHttpsAgent() {
  const insecure = String(process.env.SEFAZ_TLS_INSECURE || 'false').toLowerCase() === 'true';
  if (insecure) {
    console.warn('[SEFAZ][TLS] MODO INSEGURO ATIVADO (rejectUnauthorized=false) — use apenas para teste!');
    return new https.Agent({ rejectUnauthorized: false });
  }

  // Bundle raiz do sistema (Debian/Ubuntu)
  const systemCABundle = '/etc/ssl/certs/ca-certificates.crt';
  const customCAPath = process.env.SEFAZ_CA_PATH;

  const caList = [];

  // 1) Adiciona CA do sistema
  try {
    const sys = fs.readFileSync(systemCABundle);
    caList.push(sys);
    console.log('[SEFAZ][TLS] CA do sistema incluída:', systemCABundle);
  } catch {
    console.warn('[SEFAZ][TLS] CA do sistema não encontrada em', systemCABundle);
  }

  // 2) Adiciona sua CA custom (cadeia sem o LEAF)
  if (customCAPath) {
    try {
      const custom = fs.readFileSync(customCAPath);
      caList.push(custom);
      console.log('[SEFAZ][TLS] CA custom incluída:', customCAPath);
    } catch (e) {
      console.error('[SEFAZ][TLS] Falha lendo CA custom em', customCAPath, '-', e.message);
    }
  } else {
    console.warn('[SEFAZ][TLS] SEFAZ_CA_PATH não definido; confiando apenas na CA do sistema.');
  }

  // Se nenhuma CA foi lida, usa CAs padrão do Node
  if (caList.length === 0) {
    console.warn('[SEFAZ][TLS] Nenhuma CA carregada; usando CAs padrão do Node.');
    return new https.Agent({ rejectUnauthorized: true });
  }

  // Sugestão extra para alguns LB/SNI: calcule o servername a partir da URL
  let servername;
  try {
    const base = resolveBaseUrl();
    servername = new URL(base).hostname;
  } catch (_) {}

  return new https.Agent({
    ca: caList,
    rejectUnauthorized: true,
    servername
  });
}

/**
 * Emite guia na SEFAZ/AL (manual v2.1.0).
 * Requer header 'appToken'.
 *
 * userForSefaz: { documento: 'CNPJ_14', nomeRazaoSocial: '...' }
 * dar: { mes_referencia, ano_referencia, valor, data_vencimento, codigo_receita? }
 */
async function emitirGuiaSefaz(userForSefaz, dar) {
  const baseURL = resolveBaseUrl();
  const endpoint = process.env.SEFAZ_EMISSAO_PATH || '/api/public/guia/emitir';
  const url = baseURL + endpoint;

  // (opcional) também injeta a CA no ambiente do Node
  if (process.env.SEFAZ_CA_PATH && !process.env.NODE_EXTRA_CA_CERTS) {
    process.env.NODE_EXTRA_CA_CERTS = process.env.SEFAZ_CA_PATH;
  }

  const httpsAgent = buildHttpsAgent();

  const maxRetries = Number(process.env.SEFAZ_MAX_RETRIES || 3);
  const baseDelay = Number(process.env.SEFAZ_RETRY_BASE_MS || 1000);

  // Normalização de dados
  const mes = Number(dar.mes_referencia);
  const ano = Number(dar.ano_referencia);
  const valorPrincipal = Number(dar.valor);
  const dataVRaw = String(dar.data_vencimento || '').slice(0, 10);

  // Ajuste de data vencida -> hoje+2
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  let dataVencimento = dataVRaw;
  const parsed = new Date(dataVRaw);
  if (!dataVRaw || isNaN(parsed.getTime()) || parsed < hoje) {
    const d = new Date(); d.setDate(d.getDate() + 2);
    dataVencimento = d.toISOString().slice(0, 10);
  }

  // 4 = CNPJ
  const payload = {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: 4,
      numeroInscricao: userForSefaz.documento,
      nome: userForSefaz.nomeRazaoSocial,
      codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO || 2704302)
    },
    receitas: [
      {
        codigo: Number(dar.codigo_receita || process.env.CODIGO_RECEITA_PADRAO || 20165),
        competencia: { mes, ano },
        valorPrincipal,
        dataVencimento: dataVencimento
        // Se a receita exigir documento de origem, inclua:
        // codigoTipoDocumentoOrigem: ...,
        // numeroDocumentoOrigem: ...,
      }
    ],
    dataLimitePagamento: dataVencimento,
    observacao: `Pagamento referente ao aluguel de ${userForSefaz.nomeRazaoSocial}`
  };

  console.debug('[DEBUG] Payload SEFAZ →', JSON.stringify(payload, null, 2));

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await axios.post(url, payload, {
        httpsAgent,
        timeout: Number(process.env.SEFAZ_TIMEOUT_MS || 30000), // 30s
        family: 4, // força IPv4
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'appToken': process.env.SEFAZ_APP_TOKEN || ''
        },
        validateStatus: () => true
      });

      console.log('[SEFAZ] status:', resp.status, 'tempo(ms):', Date.now() - t0);

      if (resp.status >= 200 && resp.status < 300) {
        // Esperado: { numeroGuia, pdfBase64 }
        return resp.data;
      }

      // Log detalhado quando não é 2xx
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
