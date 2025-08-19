// src/services/sefazService.js
const axios = require('axios');
const https = require('https');

// ==========================
// ENV
// ==========================
const {
  SEFAZ_MODE = 'hom',
  SEFAZ_API_URL_HOM = 'https://acessosefaz.hom.sefaz.al.gov.br/sfz-arrecadacao-guia-api',
  SEFAZ_API_URL_PROD = 'https://acessosefaz.sefaz.al.gov.br/sfz-arrecadacao-guia-api',
  SEFAZ_APP_TOKEN,
  COD_IBGE_MUNICIPIO,
  RECEITA_CODIGO_PERMISSIONARIO,
  RECEITA_CODIGO_EVENTO,
  DOC_ORIGEM_COD,            // opcional (se sua receita exigir documento de origem)
  SEFAZ_TLS_INSECURE = 'false',
  SEFAZ_TIMEOUT_MS = '120000',  // 120s
  SEFAZ_RETRIES = '5',          // 1 tentativa + 5 retries
} = process.env;

const BASE_URL = (SEFAZ_MODE || 'hom').toLowerCase() === 'prod'
  ? SEFAZ_API_URL_PROD
  : SEFAZ_API_URL_HOM;

const httpsAgent = new https.Agent({
  rejectUnauthorized: String(SEFAZ_TLS_INSECURE).toLowerCase() !== 'true',
});

// ==========================
// AXIOS (instância oficial SEFAZ)
// ==========================
const sefaz = axios.create({
  baseURL: BASE_URL,
  timeout: Number(SEFAZ_TIMEOUT_MS || 120000),
  httpsAgent,
  headers: {
    appToken: SEFAZ_APP_TOKEN || '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// ==========================
// Helpers
// ==========================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function reqWithRetry(doRequest, label = 'sefaz-call') {
  const maxRetries = Number(SEFAZ_RETRIES || 5);
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await doRequest();
    } catch (err) {
      lastErr = err;
      const isTimeout = err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '');
      const noResp = !err?.response; // erros de rede (DNS, TCP reset etc)
      const retriable = [429, 502, 503, 504].includes(err?.response?.status);

      if (attempt < maxRetries && (isTimeout || noResp || retriable)) {
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt)); // 1s,2s,4s,8s,16s,30s
        console.warn(`[SEFAZ][retry ${attempt + 1}/${maxRetries}] ${label}: ${err.message || err}. +${delay}ms`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

const toISO = (d) => {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};

function clampDataLimitePagamento(dataVencimentoISO, dataLimiteISO) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const lim = toISO(dataLimiteISO) || toISO(dataVencimentoISO) || hojeISO;
  return lim < hojeISO ? hojeISO : lim;
}

/**
 * Normaliza código da receita (remove DV e não-dígitos).
 * Ex.: "20165-0" => 20165  |  "201650" (5+DV) => 20165
 */
function normalizeCodigoReceita(cod) {
  const num = onlyDigits(cod);
  // Muitas receitas são 5 dígitos + 1 DV → se tiver 6 e começar com 5 dígitos válidos, corta o DV
  if (num.length === 6 && /^[1-9]\d{4}\d$/.test(num)) {
    return Number(num.slice(0, 5));
  }
  return Number(num);
}

// ==========================
// Builders de Payload
// ==========================
function buildSefazPayload({
  cnpj,
  nome,
  codIbgeMunicipio,
  receitaCodigo,
  competenciaMes,
  competenciaAno,
  valorPrincipal,
  dataVencimentoISO,     // YYYY-MM-DD
  dataLimiteISO,         // YYYY-MM-DD (opcional, será clampado)
  observacao,
  docOrigem,             // opcional: { codigo: <int>, numero: <string> }
}) {
  if (!SEFAZ_APP_TOKEN) throw new Error('SEFAZ_APP_TOKEN não configurado no .env.');

  const numeroInscricao = onlyDigits(cnpj || '');
  if (numeroInscricao.length !== 14) throw new Error('CNPJ do emitente inválido.');

  const receitaCod = normalizeCodigoReceita(receitaCodigo);
  if (!receitaCod) throw new Error('Código de receita inválido/ausente.');

  const mes = Number(competenciaMes);
  const ano = Number(competenciaAno);
  if (!mes || !ano) throw new Error('Competência inválida (mês/ano).');

  const dataVenc = toISO(dataVencimentoISO);
  if (!dataVenc) throw new Error('dataVencimento inválida/ausente (YYYY-MM-DD).');

  const dataLimitePagamento = clampDataLimitePagamento(dataVenc, dataLimiteISO);

  const payload = {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: 4, // 4 = CNPJ
      numeroInscricao,
      nome: nome || 'Contribuinte',
      codigoIbgeMunicipio: Number(codIbgeMunicipio || COD_IBGE_MUNICIPIO || 0),
      // descricaoEndereco / numeroCep são opcionais na maioria das UGs
    },
    receitas: [{
      codigo: receitaCod,
      competencia: { mes, ano },
      ...(docOrigem?.codigo ? { codigoTipoDocumentoOrigem: Number(docOrigem.codigo) } : {}),
      ...(docOrigem?.numero ? { numeroDocumentoOrigem: String(docOrigem.numero) } : {}),
      valorPrincipal: Number(valorPrincipal || 0),
      valorDesconto: 0,
      dataVencimento: dataVenc,
    }],
    dataLimitePagamento,
    observacao: (observacao || '').slice(0, 255),
  };

  if (!payload.contribuinteEmitente.codigoIbgeMunicipio) {
    throw new Error('codigoIbgeMunicipio é obrigatório (COD_IBGE_MUNICIPIO).');
  }
  if (!(payload.receitas[0].valorPrincipal > 0)) {
    throw new Error('valorPrincipal deve ser > 0.');
  }

  return payload;
}

/**
 * Permissionários (aluguel)
 *   perm: { cnpj, nome_empresa }
 *   darLike: { valor, data_vencimento, mes_referencia, ano_referencia, id? }
 */
function buildSefazPayloadPermissionario({ perm, darLike, receitaCodigo = RECEITA_CODIGO_PERMISSIONARIO }) {
  const cnpj = onlyDigits(perm?.cnpj || '');
  const nome = perm?.nome_empresa || 'Contribuinte';
  const valor = Number(darLike?.valor || 0);
  const dataVencISO = toISO(darLike?.data_vencimento);
  const mes = Number(darLike?.mes_referencia || 0);
  const ano = Number(darLike?.ano_referencia || 0);

  const docOrigem = DOC_ORIGEM_COD
    ? { codigo: Number(DOC_ORIGEM_COD), numero: String(darLike?.id || darLike?.numero_documento || darLike?.referencia || '') || String(Date.now()) }
    : null;

  return buildSefazPayload({
    cnpj,
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo,
    competenciaMes: mes,
    competenciaAno: ano,
    valorPrincipal: valor,
    dataVencimentoISO: dataVencISO,
    dataLimiteISO: dataVencISO, // será clampado para >= hoje
    observacao: `Aluguel CIPT - ${nome}`,
    docOrigem,
  });
}

/**
 * Eventos (se usar receita distinta)
 *   cliente: { cnpj, nome_razao_social }
 *   parcela: { valor, vencimento, competenciaMes, competenciaAno, id? }
 */
function buildSefazPayloadEvento({ cliente, parcela, receitaCodigo = RECEITA_CODIGO_EVENTO }) {
  const cnpj = onlyDigits(cliente?.cnpj || cliente?.documento || '');
  const nome = cliente?.nome_razao_social || cliente?.nome || 'Contribuinte';
  const valor = Number(parcela?.valor || parcela?.valorPrincipal || 0);
  const dataVencISO = toISO(parcela?.vencimento || parcela?.data_vencimento);
  const mes = Number(parcela?.competenciaMes || parcela?.mes || 0);
  const ano = Number(parcela?.competenciaAno || parcela?.ano || 0);

  const docOrigem = DOC_ORIGEM_COD
    ? { codigo: Number(DOC_ORIGEM_COD), numero: String(parcela?.id || parcela?.referencia || '') || String(Date.now()) }
    : null;

  return buildSefazPayload({
    cnpj,
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo,
    competenciaMes: mes,
    competenciaAno: ano,
    valorPrincipal: valor,
    dataVencimentoISO: dataVencISO,
    dataLimiteISO: dataVencISO,
    observacao: `Evento CIPT - ${nome}`,
    docOrigem,
  });
}

// ==========================
// Emissão de Guia
// ==========================
async function _postEmitir(payload) {
  if (!SEFAZ_APP_TOKEN) {
    throw new Error('SEFAZ_APP_TOKEN não configurado no .env.');
  }
  try {
    const { data } = await reqWithRetry(
      () => sefaz.post('/api/public/guia/emitir', payload),
      'guia/emitir'
    );
    if (!data || !data.numeroGuia || !data.pdfBase64) {
      throw new Error('Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).');
    }
    return data;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const body = err.response.data;
      // log raw body for troubleshooting
      console.error(body);
      const msg = (body && (body.message || body.detail || body.title)) || `Erro HTTP ${status}`;
      if (/Data Limite Pagamento.*menor que a data atual/i.test(JSON.stringify(body))) {
        throw new Error('Data Limite Pagamento não pode ser menor que hoje. (Ajuste automático recomendado no payload)');
      }
      throw new Error(`Erro ${status}: ${msg} - ${JSON.stringify(body)}`);
    }
    if (err.request) {
      const reason = (err.code === 'ECONNABORTED') ? 'timeout' : 'sem resposta';
      throw new Error(`A SEFAZ não respondeu (${reason}). Verifique a VPN/Infovia e a disponibilidade do serviço.`);
    }
    throw new Error(err.message || 'Falha desconhecida ao emitir guia.');
  }
}

/**
 * Forma preferida: emitirGuiaSefaz(payloadPronto)
 *
 * Compat: emitirGuiaSefaz(contribuinte, guiaLike) → monta payload perm.
 */
async function emitirGuiaSefaz(arg1, arg2) {
  // payload já no formato do manual?
  if (arg1 && typeof arg1 === 'object' && arg1.versao && arg1.contribuinteEmitente && arg1.receitas) {
    return _postEmitir(arg1);
  }
  // Compat (contribuinte, guiaLike)
  if (arg1 && arg2) {
    const contrib = arg1 || {};
    const guia = arg2 || {};

    const fakeDarLike = {
      valor: guia.valor || guia.valorPrincipal || 0,
      data_vencimento: guia.data_vencimento || guia.vencimento || guia.dataVencimento,
      mes_referencia: guia.mes_referencia || guia.competencia?.mes || guia.mes,
      ano_referencia: guia.ano_referencia || guia.competencia?.ano || guia.ano,
      id: guia.id || guia.referencia || null,
      numero_documento: guia.numero_documento || null,
    };

    const payload = buildSefazPayloadPermissionario({
      perm: { cnpj: contrib.documento || contrib.cnpj, nome_empresa: contrib.nomeRazaoSocial || contrib.nome },
      darLike: fakeDarLike,
      receitaCodigo: RECEITA_CODIGO_PERMISSIONARIO,
    });

    return _postEmitir(payload);
  }
  throw new Error('emitirGuiaSefaz: chame com payload pronto ou (contribuinte, guiaLike).');
}

// ==========================
// Consultas
// ==========================
/**
 * Consulta metadados da receita (saber se exige doc de origem, etc.)
 * GET /api/public/receita/consultar?codigo=NNNNN
 */
async function consultarReceita(codigo) {
  const cod = normalizeCodigoReceita(codigo);
  try {
    const { data } = await reqWithRetry(
      () => sefaz.get('/api/public/receita/consultar', { params: { codigo: cod } }),
      'receita/consultar'
    );
    return data;
  } catch {
    return null;
  }
}

/**
 * Lista pagamentos por DATA DE ARRECADAÇÃO (YYYY-MM-DD a YYYY-MM-DD)
 */
async function listarPagamentosPorDataArrecadacao(dataInicioISO, dataFimISO, codigoReceita) {
  const params = { dataInicio: dataInicioISO, dataFim: dataFimISO };
  if (codigoReceita) params.codigoReceita = normalizeCodigoReceita(codigoReceita);

  const { data } = await reqWithRetry(
    () => sefaz.get('/api/public/pagamento/por-data-arrecadacao', { params }),
    'pagamento/por-data-arrecadacao'
  );

  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.map(it => ({
    numeroGuia: it.numeroGuia || it.numero || it.codigoBarras || it.linhaDigitavel || null,
    dataPagamento: it.dataPagamento || it.dtPagamento || null,
    valorPago: it.valorPago || it.valor || null,
    raw: it,
  }));
}

/**
 * Lista pagamentos por DATA DE INCLUSÃO (YYYY-MM-DDTHH:mm:ss a YYYY-MM-DDTHH:mm:ss)
 */
async function listarPagamentosPorDataInclusao(dataInicioISODateTime, dataFimISODateTime, codigoReceita) {
  const params = { dataInicio: dataInicioISODateTime, dataFim: dataFimISODateTime };
  if (codigoReceita) params.codigoReceita = normalizeCodigoReceita(codigoReceita);

  const { data } = await reqWithRetry(
    () => sefaz.get('/api/public/pagamento/por-data-inclusao', { params }),
    'pagamento/por-data-inclusao'
  );

  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.map(it => ({
    numeroGuia: it.numeroGuia || it.numero || it.codigoBarras || it.linhaDigitavel || null,
    dataPagamento: it.dataPagamento || it.dtPagamento || null,
    valorPago: it.valorPago || it.valor || null,
    raw: it,
  }));
}

// ==========================
// Exports
// ==========================
module.exports = {
  emitirGuiaSefaz,
  buildSefazPayloadPermissionario,
  buildSefazPayloadEvento,
  buildSefazPayload,
  consultarReceita,
  // utils
  toISO,
  onlyDigits,
  normalizeCodigoReceita,
  // conciliação
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
};
