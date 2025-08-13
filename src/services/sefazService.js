// src/services/sefazService.js
const axios = require('axios');
const https = require('https');

/**
 * Lê variáveis de ambiente (.env)
 */
const {
  SEFAZ_MODE = 'hom',
  SEFAZ_API_URL_HOM = 'https://acessosefaz.hom.sefaz.al.gov.br/sfz-arrecadacao-guia-api',
  SEFAZ_API_URL_PROD = 'https://acessosefaz.sefaz.al.gov.br/sfz-arrecadacao-guia-api',
  SEFAZ_APP_TOKEN,
  COD_IBGE_MUNICIPIO,
  RECEITA_CODIGO_PERMISSIONARIO,
  RECEITA_CODIGO_EVENTO,
  DOC_ORIGEM_COD,          // opcional (depende da receita)
  SEFAZ_TLS_INSECURE = 'false',
} = process.env;

const BASE_URL = (SEFAZ_MODE || 'hom').toLowerCase() === 'prod'
  ? SEFAZ_API_URL_PROD
  : SEFAZ_API_URL_HOM;

// Agent para ambientes com TLS interceptado/autoassinado (se precisar)
const httpsAgent = new https.Agent({
  rejectUnauthorized: String(SEFAZ_TLS_INSECURE).toLowerCase() !== 'true' ? true : false,
});

// Instância Axios configurada
const sefaz = axios.create({
  baseURL: BASE_URL,
  timeout: 120000, // 120s
  httpsAgent,
  headers: {
    // Header OBRIGATÓRIO segundo o manual
    appToken: SEFAZ_APP_TOKEN || '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/** Utils */
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const toISO = (d) => {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};

/**
 * Garante que a data limite não seja menor que hoje.
 */
function clampDataLimitePagamento(dataVencimentoISO, dataLimiteISO) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const lim = toISO(dataLimiteISO) || toISO(dataVencimentoISO) || hojeISO;
  return lim < hojeISO ? hojeISO : lim;
}

/**
 * Normaliza código de receita (remove DV e não-dígitos).
 * Ex.: "20165-0" -> 20165
 */
function normalizeCodigoReceita(cod) {
  const num = onlyDigits(cod);
  // se vier "201650", e o último dígito for DV, remova 1 dígito:
  // regra simples: muitas receitas são 5 dígitos + 1 DV. Se tiver 6 e começar com "20165", corta o último.
  if (num.length === 6 && /^[1-9]\d{4}/.test(num)) {
    return Number(num.slice(0, 5));
  }
  return Number(num);
}

/**
 * Builder GENERICÃO de payload (use se quiser montar “na mão”).
 */
function buildSefazPayload({
  cnpj,
  nome,
  codIbgeMunicipio,
  receitaCodigo,
  competenciaMes,
  competenciaAno,
  valorPrincipal,
  dataVencimentoISO,     // YYYY-MM-DD
  dataLimiteISO,         // YYYY-MM-DD (opcional; será clampado)
  observacao,
  docOrigem,             // opcional: { codigo: <int>, numero: <string> }
}) {
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
      codigoTipoInscricao: 4, // 4=CNPJ
      numeroInscricao,
      nome: nome || 'Contribuinte',
      codigoIbgeMunicipio: Number(codIbgeMunicipio || COD_IBGE_MUNICIPIO || 0),
      // descricaoEndereco / numeroCep: OPCIONAIS
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
 * Builder específico para DARs de Permissionários
 *   perm: { cnpj, nome_empresa }
 *   darLike: { valor, data_vencimento, mes_referencia, ano_referencia }
 */
function buildSefazPayloadPermissionario({ perm, darLike, receitaCodigo = RECEITA_CODIGO_PERMISSIONARIO }) {
  const cnpj = onlyDigits(perm?.cnpj || '');
  const nome = perm?.nome_empresa || 'Contribuinte';
  const valor = Number(darLike?.valor || 0);
  const dataVencISO = toISO(darLike?.data_vencimento);
  const mes = Number(darLike?.mes_referencia || 0);
  const ano = Number(darLike?.ano_referencia || 0);

  // documento de origem (se a receita exigir, configure DOC_ORIGEM_COD no .env e passe um número aqui)
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
 * Builder específico para DARs de Eventos (caso você use receita distinta)
 *   cliente: { cnpj, nome_razao_social }
 *   parcela: { valor, vencimento, competenciaMes, competenciaAno }
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

/**
 * Emissão da Guia na SEFAZ.
 * Forma preferida: emitirGuiaSefaz(payloadPronto)
 *   - payloadPronto: objeto no formato do manual, gerado por um dos builders acima.
 *
 * Compatibilidade retro:
 *   emitirGuiaSefaz(contribuinte, guiaLike)
 *   -> monta payload mínimo automaticamente (APENAS se possível)
 */
async function emitirGuiaSefaz(arg1, arg2) {
  // Se vier payload já formatado
  if (arg1 && typeof arg1 === 'object' && arg1.versao && arg1.contribuinteEmitente && arg1.receitas) {
    return _postEmitir(arg1);
  }

  // Compat legacy: (contribuinte, guiaLike)
  // Só para não quebrar rotas antigas – tenta montar com RECEITA_CODIGO_PERMISSIONARIO.
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

/**
 * POST /api/public/guia/emitir
 */
async function _postEmitir(payload) {
  if (!SEFAZ_APP_TOKEN) {
    throw new Error('SEFAZ_APP_TOKEN não configurado no .env.');
  }
  try {
    const { data } = await sefaz.post('/api/public/guia/emitir', payload);
    // Esperado: { numeroGuia, pdfBase64, ... }
    if (!data || !data.numeroGuia || !data.pdfBase64) {
      throw new Error('Retorno da SEFAZ incompleto (sem numeroGuia/pdfBase64).');
    }
    return data;
  } catch (err) {
    // Erro com resposta HTTP (4xx/5xx)
    if (err.response) {
      const status = err.response.status;
      const body = err.response.data;
      // Manual diz que usam RFC7807 (problem+json) com "message"/"status"
      const msg = (body && (body.message || body.detail || body.title)) || `Erro HTTP ${status}`;
      // tratar o caso clássico: Data Limite menor que hoje
      if (/Data Limite Pagamento.*menor que a data atual/i.test(JSON.stringify(body))) {
        throw new Error('Data Limite Pagamento não pode ser menor que hoje. (Ajuste automático recomendado no payload)');
      }
      throw new Error(`Erro ${status}: ${msg}`);
    }

    // Erro de rede / timeout (sem resposta)
    if (err.request) {
      const reason = (err.code === 'ECONNABORTED') ? 'timeout' : 'sem resposta';
      throw new Error(`A SEFAZ não respondeu (${reason}). Verifique a VPN/Infovia e a disponibilidade do serviço.`);
    }

    // Erro de programação/outros
    throw new Error(err.message || 'Falha desconhecida ao emitir guia.');
  }
}

/**
 * (Opcional) Consulta metadados da receita para saber se exige “documento de origem”.
 * GET /api/public/receita/consultar?codigo=NNNNN
 */
async function consultarReceita(codigo) {
  const cod = normalizeCodigoReceita(codigo);
  try {
    const { data } = await sefaz.get('/api/public/receita/consultar', {
      params: { codigo: cod },
    });
    return data;
  } catch (err) {
    // Melhor não explodir: quem chamar decide o que fazer
    return null;
  }
}

// ============= NOVO: CONSULTAR GUIA (por número) =============
/**
 * Consulta uma guia individual na SEFAZ.
 * Esperado que o retorno tenha algo como: { numeroGuia, dataPagamento, ... }
 */
async function consultarGuia(numeroGuia) {
  try {
    const url = `${PATH_CONSULTA_GUIA}/${encodeURIComponent(numeroGuia)}`;
    const { data } = await api.get(url);
    return data;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      throw new Error('Timeout consultando a SEFAZ (guia individual).');
    }
    if (err.response) {
      const { status, data } = err.response;
      const msg = data?.message || data?.title || 'Erro desconhecido';
      throw new Error(`Erro ${status} ao consultar guia ${numeroGuia}: ${msg}`);
    }
    throw new Error(`Falha ao consultar guia ${numeroGuia}: ${err.message}`);
  }
}

// ============= NOVO: CONSULTAR POR PERÍODO =============
/**
 * Faz uma busca por período (D-1) filtrando por receita.
 * Cada UG pode usar "dataInclusao" OU "dataArrecadacao". Ajuste os nomes de query abaixo
 * de acordo com o manual da sua UG.
 *
 * Retorno esperado: lista com objetos contendo ao menos { numeroGuia, dataPagamento, ... }
 */
async function consultarPagamentosPorPeriodo({ inicioISO, fimISO, receitaCodigo }) {
  try {
    // Exemplos de filtros (ajuste para sua API):
    const params = {
      receitaCodigo: receitaCodigo,
      dataInclusaoInicial: `${inicioISO} 00:00:00`,
      dataInclusaoFinal:   `${fimISO} 23:59:59`,
      // ou use dataArrecadacaoInicial / dataArrecadacaoFinal, conforme a recomendação da UG
    };
    const { data } = await api.get(PATH_CONSULTA_PER, { params });
    // Normalizar para array
    return Array.isArray(data) ? data : (data?.content || data?.result || []);
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      throw new Error('Timeout consultando a SEFAZ (período).');
    }
    if (err.response) {
      const { status, data } = err.response;
      const msg = data?.message || data?.title || 'Erro desconhecido';
      throw new Error(`Erro ${status} na consulta por período: ${msg}`);
    }
    throw new Error(`Falha na consulta por período: ${err.message}`);
  }
}

module.exports = {
  emitirGuiaSefaz,
  buildSefazPayloadPermissionario,
  buildSefazPayloadEvento,
  buildSefazPayload,
  consultarReceita,
  // utils exportados se precisar em outros módulos
  toISO,
  onlyDigits,
  normalizeCodigoReceita,
  consultarGuia,
  consultarPagamentosPorPeriodo,
};