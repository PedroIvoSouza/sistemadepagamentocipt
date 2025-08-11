// src/services/sefazService.js
const fs = require('fs');
const https = require('https');
const axios = require('axios');

function onlyDigits(v = '') {
  return String(v).replace(/\D/g, '');
}

// "1.234,56" | "1234,56" | 1234.56 -> Number
function toNumberBR(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// Detecta CPF/CNPJ e retorna { tipo: 3|4, numero: 'xxxxxxxxxxx/xxxxxxxxxxxx' }
function resolveDocumento({ dar, user, override = {} }) {
  // 1) overrides (para eventos)
  let doc = override.documento || override.doc || '';
  let nome = override.nome || '';

  // 2) campos típicos de EVENTO
  if (!doc) doc = dar?.cliente_cpf || dar?.cliente_cnpj || dar?.documento;
  if (!nome) nome = dar?.nome_cliente || dar?.cliente_nome || dar?.nome;

  // 3) campos de PERMISSIONÁRIO (fallback)
  if (!doc) doc = user?.cnpj;
  if (!nome) nome = user?.nome_empresa || user?.razao_social || user?.nome;

  doc = onlyDigits(doc || '');
  nome = (nome || '').toString().trim();

  let tipo = null;
  if (doc.length === 11) tipo = 3;   // CPF
  if (doc.length === 14) tipo = 4;   // CNPJ

  return { tipo, numero: doc, nome };
}

function buildPayloadSefaz({ user, dar, override = {}, codigoIbge }) {
  // Resolve nome/doc do contribuinte (evento ou permissionário)
  const { tipo, numero, nome } = resolveDocumento({ dar, user, override });

  if (!tipo || !numero) {
    throw new Error('Documento do contribuinte ausente ou inválido (CPF/CNPJ).');
  }

  const nomeContribuinte = nome || 'Contribuinte';

  // Valor principal
  let valorPrincipal = toNumberBR(dar?.valor);
  if (!Number.isFinite(valorPrincipal) || valorPrincipal <= 0) {
    valorPrincipal = toNumberBR(dar?.valor_principal ?? dar?.valor_total ?? dar?.valorBase);
  }
  if (!Number.isFinite(valorPrincipal) || valorPrincipal <= 0) {
    throw new Error('Valor principal inválido para emissão da guia.');
  }

  const competenciaMes = Number(dar?.mes_referencia || dar?.mes || dar?.competencia_mes || 0);
  const competenciaAno = Number(dar?.ano_referencia || dar?.ano || dar?.competencia_ano || 0);

  const dataVenc =
    dar?.data_vencimento ||
    dar?.vencimento ||
    dar?.dataLimitePagamento ||
    null;

  const codigoReceita = Number(
    dar?.codigo_receita || process.env.CODIGO_RECEITA_PADRAO || 20165
  );

  const payload = {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: tipo,          // 3 = CPF | 4 = CNPJ
      numeroInscricao: numero,            // só dígitos
      nome: nomeContribuinte,
      codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO || codigoIbge || 2704302),
    },
    receitas: [
      {
        codigo: codigoReceita,
        competencia: (competenciaMes && competenciaAno)
          ? { mes: competenciaMes, ano: competenciaAno }
          : undefined,
        valorPrincipal, // número
        dataVencimento: dataVenc ? String(dataVenc).slice(0, 10) : undefined,
      },
    ].map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => v != null))),
    dataLimitePagamento: dataVenc ? String(dataVenc).slice(0, 10) : undefined,
    observacao: dar?.observacao || `Pagamento referente ao ${nomeContribuinte}`,
  };

  // Validações finais (evita 400)
  if (!payload.contribuinteEmitente?.nome) {
    throw new Error('Nome do contribuinte ausente ao montar o payload para SEFAZ.');
  }
  if (!Number.isFinite(payload?.receitas?.[0]?.valorPrincipal)) {
    throw new Error('Valor principal ausente ou inválido ao montar o payload para SEFAZ.');
  }

  return payload;
}

async function emitirGuiaSefaz(user, dar, override = {}) {
  const mode = (process.env.SEFAZ_MODE || 'hom').toLowerCase();
  const baseURL = mode === 'prod'
    ? process.env.SEFAZ_API_URL_PROD
    : process.env.SEFAZ_API_URL_HOM;

  const url = `${baseURL}${process.env.SEFAZ_EMISSAO_PATH || '/api/public/guia/emitir'}`;
  const appToken = process.env.SEFAZ_APP_TOKEN;

  const insecure = String(process.env.SEFAZ_TLS_INSECURE || 'false').toLowerCase() === 'true';
  const caPath   = process.env.SEFAZ_CA_PATH;

  let httpsAgent;
  if (insecure) {
    httpsAgent = new https.Agent({ rejectUnauthorized: false });
    console.warn('[SEFAZ][TLS] MODO INSEGURO ATIVADO (rejectUnauthorized=false) — use apenas para teste!');
  } else if (caPath && fs.existsSync(caPath)) {
    httpsAgent = new https.Agent({ ca: fs.readFileSync(caPath) });
  } else {
    httpsAgent = new https.Agent();
  }

  const payload = buildPayloadSefaz({ user, dar, override });

  const timeout = Number(process.env.SEFAZ_TIMEOUT_MS || 15000);
  const maxRetries = Number(process.env.SEFAZ_MAX_RETRIES || 3);
  const backoffBase = Number(process.env.SEFAZ_RETRY_BASE_MS || 1000);

  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      const res = await axios.post(url, payload, {
        timeout,
        httpsAgent,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          appToken: appToken,
        },
        validateStatus: () => true,
      });
      const ms = Date.now() - t0;
      console.log(`[SEFAZ] status: ${res.status} tempo(ms): ${ms}`);

      if (res.status >= 200 && res.status < 300) {
        return res.data;
      }

      if (res.status === 400 || res.status === 401 || res.status === 403) {
        console.error('----------------- ERRO DETALHADO -----------------');
        console.error('Mensagem:', `Request failed with status code ${res.status}`);
        console.error('Status:', res.status);
        console.error('Body:', JSON.stringify(res.data, null, 2));
        console.error('----------------------------------------------------');
        throw new Error(
          res.status === 400 ? 'SEFAZ respondeu 400 (payload inválido).'
          : res.status === 401 || res.status === 403 ? `SEFAZ respondeu ${res.status} (acesso negado).`
          : `SEFAZ respondeu ${res.status}.`
        );
      }

      if (res.status >= 500) {
        const body = JSON.stringify(res.data) || '';
        if (body.includes('Load balancer does not have available server')) {
          lastErr = new Error('SEFAZ indisponível (balanceador sem instâncias).');
        } else {
          lastErr = new Error(`SEFAZ retornou ${res.status}.`);
        }
      } else {
        lastErr = new Error(`Falha SEFAZ: HTTP ${res.status}.`);
      }
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      const fatal =
        msg.includes('payload inválido') ||
        msg.includes('acesso negado') ||
        msg.includes('Documento do contribuinte ausente') ||
        msg.includes('Nome do contribuinte ausente') ||
        msg.includes('Valor principal ausente');

      if (fatal || attempt === maxRetries - 1) break;

      const wait = backoffBase * Math.pow(2, attempt);
      console.log(`[SEFAZ] retry ${attempt + 1}/${maxRetries - 1} em ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = { emitirGuiaSefaz };
