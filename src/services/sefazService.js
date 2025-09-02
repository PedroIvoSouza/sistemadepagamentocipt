// src/services/sefazService.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
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
  RECEITA_CODIGO_EVENTO_PF,
  RECEITA_CODIGO_EVENTO_PJ,
  DOC_ORIGEM_COD,            // opcional (se sua receita exigir documento de origem)
  SEFAZ_TLS_INSECURE = 'true',
  SEFAZ_TIMEOUT_MS = '120000', // 120s
  SEFAZ_RETRIES = '5',         // 1 tentativa + 5 retries
} = process.env;


// ==========================================================
// === CÓDIGO DE VERIFICAÇÃO ADICIONADO AQUI ===
// ==========================================================
console.log('\n--- VERIFICANDO VARIÁVEIS DE AMBIENTE CARREGADAS ---');
console.log(`SEFAZ_MODE: [${process.env.SEFAZ_MODE}]`);
console.log(`SEFAZ_TLS_INSECURE: [${process.env.SEFAZ_TLS_INSECURE}]`);
console.log(`SEFAZ_APP_TOKEN (primeiros 5 caracteres): [${String(process.env.SEFAZ_APP_TOKEN || '').slice(0, 5)}...]`);
console.log('----------------------------------------------------\n');
// ==========================================================


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
    proxy: false,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'appToken': getAppTokenStrict(),
    },
});

// Mapeamento de tipo de inscrição conforme a API da SEFAZ
const TIPO_INSCRICAO = { CPF: 3, CNPJ: 4 };

// ==========================================
// === INTERCEPTOR DE DEBUG ADICIONADO AQUI ===
// ==========================================
sefaz.interceptors.request.use(request => {
  const maskedHeaders = { ...request.headers };
  if (maskedHeaders && maskedHeaders.appToken) {
    const t = String(maskedHeaders.appToken);
    maskedHeaders.appToken = t.length > 8 ? `${t.slice(0,4)}…${t.slice(-4)}` : '***';
  }

  console.log('\n--- AXIOS REQUEST INTERCEPTOR ---');
  console.log('Enviando requisição:');
  console.log(`- Método: ${request.method.toUpperCase()}`);
  console.log(`- URL Base: ${request.baseURL}`);
  console.log(`- Caminho: ${request.url}`);
  console.log(`- URL Completa: ${request.baseURL}${request.url}`);
  console.log('- Headers:', JSON.stringify(maskedHeaders, null, 2));
  if (request.data) console.log('- Corpo (Payload):', JSON.stringify(request.data, null, 2));
  console.log('---------------------------------\n');
  return request;
}, error => {
  console.error('--- AXIOS REQUEST ERROR ---', error);
  return Promise.reject(error);
});
// ==========================================


// ==========================
// Helpers
// ==========================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanHeaderValue(s) {
  return (s ?? '').toString().replace(/[\r\n]/g, '').trim();
}

function getAppTokenStrict() {
  const v = cleanHeaderValue(process.env.SEFAZ_APP_TOKEN);
  if (!v) throw new Error('SEFAZ_APP_TOKEN não configurado no .env.');
  if (/[\u0000-\u001F\u007F]/.test(v)) throw new Error('SEFAZ_APP_TOKEN contém caracteres de controle');
  return v;
}

async function reqWithRetry(doRequest, label = 'sefaz-call') {
  const maxRetries = Number(SEFAZ_RETRIES || 5);
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await doRequest();
    } catch (err) {
      lastErr = err;

      // ==========================================================
      // ===  NOVA LÓGICA DE LOG DE ERRO DETALHADO ADICIONADA AQUI ===
      // ==========================================================
      if (err.response) {
        // Se a API retornou um erro (4xx, 5xx), loga o corpo da resposta
        console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(`[SEFAZ][${label}] ERRO DA API (Status: ${err.response.status})`);
        console.error(`[SEFAZ][${label}] RESPOSTA COMPLETA DA API:`, JSON.stringify(err.response.data, null, 2));
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
      }
      // ==========================================================

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
// Aceita documento (CPF ou CNPJ). Mantém cnpj para retrocompat.
function buildSefazPayload({
  documento,
  cnpj,
  nome,
  codIbgeMunicipio,
  receitaCodigo,
  competenciaMes,
  competenciaAno,
  valorPrincipal,
  dataVencimentoISO,      // YYYY-MM-DD
  dataLimiteISO,          // YYYY-MM-DD (opcional, será clampado)
  observacao,
  docOrigem,              // opcional: { codigo: <int>, numero: <string> }
}) {
  // valida o token em runtime
  getAppTokenStrict();

  const numeroInscricao = onlyDigits(documento || cnpj || '');
  const len = numeroInscricao.length;

  let codigoTipoInscricao;
  if (len === 11) {
    codigoTipoInscricao = TIPO_INSCRICAO.CPF;
  } else if (len === 14) {
    codigoTipoInscricao = TIPO_INSCRICAO.CNPJ;
  } else {
    throw new Error('Documento do emitente inválido (CPF com 11 dígitos ou CNPJ com 14).');
  }

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
      codigoTipoInscricao,   // agora dinâmico
      numeroInscricao,
      nome: nome || 'Contribuinte',
      codigoIbgeMunicipio: Number(codIbgeMunicipio || COD_IBGE_MUNICIPIO || 0),
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

function pickReceitaEventoByDoc(docDigits, receitaOverride) {
  if (receitaOverride) return normalizeCodigoReceita(receitaOverride);
  
  const receitaPF = process.env.RECEITA_CODIGO_EVENTO_PF || process.env.RECEITA_CODIGO_EVENTO;
  const receitaPJ = process.env.RECEITA_CODIGO_EVENTO_PJ || process.env.RECEITA_CODIGO_EVENTO || process.env.RECEITA_CODIGO_PERMISSIONARIO;

  if (docDigits.length === 11) {
    const cod = normalizeCodigoReceita(receitaPF);
    if (!cod) throw new Error('Código de receita de EVENTO para PF não configurado. Defina RECEITA_CODIGO_EVENTO_PF.');
    return cod;
  }
  if (docDigits.length === 14) {
    const cod = normalizeCodigoReceita(receitaPJ);
    if (!cod) throw new Error('Código de receita de EVENTO para PJ não configurado. Defina RECEITA_CODIGO_EVENTO_PJ.');
    return cod;
  }
  throw new Error('Documento inválido para evento (CPF 11 dígitos ou CNPJ 14).');
}


/**
 * Permissionários (aluguel)
 * perm: { cnpj, nome_empresa }
 * darLike: { valor, data_vencimento, mes_referencia, ano_referencia, id? }
 */
function buildSefazPayloadPermissionario({ perm, darLike, receitaCodigo = RECEITA_CODIGO_PERMISSIONARIO }) {
  // antes usávamos "cnpj" direto; agora padronizamos como "documento" (pode ser CPF/CNPJ)
  const documento = onlyDigits(perm?.cnpj || perm?.documento || '');
  const nome = perm?.nome_empresa || perm?.nome || 'Contribuinte';

  const valor = Number(darLike?.valor || 0);
  const dataVencISO = toISO(darLike?.data_vencimento);
  const mes = Number(darLike?.mes_referencia || 0);
  const ano = Number(darLike?.ano_referencia || 0);

  const docOrigem = DOC_ORIGEM_COD
    ? { codigo: Number(DOC_ORIGEM_COD), numero: String(darLike?.id || darLike?.numero_documento || darLike?.referencia || '') || String(Date.now()) }
    : null;

  return buildSefazPayload({
    documento,                                  // 👈 agora definido
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo: receitaCodigo || RECEITA_CODIGO_PERMISSIONARIO,
    competenciaMes: mes,
    competenciaAno: ano,
    valorPrincipal: valor,
    dataVencimentoISO: dataVencISO,
    dataLimiteISO: dataVencISO,                 // será clampado >= hoje
    observacao: `Aluguel CIPT - ${nome}`,
    docOrigem,
  });
}

/**
 * Eventos (se usar receita distinta)
 * cliente: { cnpj, nome_razao_social }
 * parcela: { valor, vencimento, competenciaMes, competenciaAno, id? }
 */
function buildSefazPayloadEvento({ cliente, parcela, receitaCodigo }) {
  const doc = onlyDigits(cliente?.cnpj || cliente?.documento || '');
  const nome = cliente?.nome_razao_social || cliente?.nome || 'Contribuinte';
  const valor = Number(parcela?.valor || parcela?.valorPrincipal || 0);
  const dataVencISO = toISO(parcela?.vencimento || parcela?.data_vencimento);
  const mes = Number(parcela?.competenciaMes || parcela?.mes || 0);
  const ano = Number(parcela?.competenciaAno || parcela?.ano || 0);

  // Lógica de seleção de receita centralizada na função pickReceitaEventoByDoc
  const receitaPorTipo = pickReceitaEventoByDoc(doc, receitaCodigo);

  const docOrigem = DOC_ORIGEM_COD
    ? { codigo: Number(DOC_ORIGEM_COD), numero: String(parcela?.id || parcela?.referencia || '') || String(Date.now()) }
    : null;

  return buildSefazPayload({
    documento: doc,
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo: receitaPorTipo,        // << usa a receita compatível
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
  const APP_TOKEN = getAppTokenStrict(); // ← sanitiza só aqui

  const receitas = Array.isArray(payload?.receitas)
    ? payload.receitas.map((r, i) => {
        const codigo = Number(String(r?.codigo).replace(/\D/g, ''));
        if (!codigo) throw new Error(`Código de receita inválido em receitas[${i}].`);
        return { ...r, codigo };
      })
    : (() => { throw new Error('Payload sem receitas.'); })();
  const payloadLimpo = { ...payload, receitas };

  try {
    const { data } = await reqWithRetry(
      () => sefaz.post('/api/public/guia/emitir', payloadLimpo, {
        headers: {
          // override só nesta request (não altera instância global)
          'appToken': APP_TOKEN,
          'Content-Type': 'application/json',
        },
        // se você usa httpsAgent/tls aqui, mantenha:
        httpsAgent,
        proxy: false,
        timeout: 15000,
      }),
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
      console.error('[SEFAZ][EMIT] response error:', status, body);
      const msg = (body && (body.message || body.detail || body.title)) || `Erro HTTP ${status}`;

      if (/Data Limite Pagamento.*menor que a data atual/i.test(JSON.stringify(body))) {
        const e = new Error('Data Limite Pagamento não pode ser menor que hoje. (Ajuste automático recomendado no payload)');
        e.status = status; e.detail = body;
        throw e;
      }
      const e = new Error(msg);
      e.status = status; e.detail = body;
      throw e;
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

const axios = require('axios');

function isPayload(obj) {
  return obj && typeof obj === 'object'
    && obj.contribuinteEmitente
    && Array.isArray(obj.receitas)
    && obj.receitas.length > 0;
}

function isContrib(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const { codigoTipoInscricao, numeroInscricao, nome, codigoIbgeMunicipio } = obj;
  return (codigoTipoInscricao === 3 || codigoTipoInscricao === 4)
      && typeof numeroInscricao === 'string'
      && numeroInscricao.replace(/\D/g, '').length > 0
      && typeof nome === 'string'
      && (codigoIbgeMunicipio ? true : true); // não travar se vier 0/undefined
}

function isGuiaLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // aceita tanto formato “simples” quanto já pronto (com competencia)
  return (
    typeof obj === 'object' &&
    (
      (obj.codigo && obj.competencia && obj.dataVencimento && (obj.valorPrincipal ?? obj.valor)) ||
      (obj.data_vencimento && (obj.valor ?? obj.valorPrincipal))
    )
  );
}

function normalizePayload(p) {
  // Garante tipos e chaves mínimas
  const cp = { ...p };
  const rec = { ...cp.receitas[0] };

  // aceita competencia {mes,ano} como string/number
  if (rec.competencia) {
    rec.competencia = {
      mes: Number(rec.competencia.mes),
      ano: Number(rec.competencia.ano),
    };
  }

  // normaliza campos de valor e data
  if (rec.valor == null && rec.valorPrincipal != null) rec.valor = rec.valorPrincipal;
  if (!rec.dataVencimento && cp.dataLimitePagamento) rec.dataVencimento = cp.dataLimitePagamento;

  cp.receitas = [rec];
  return cp;
}

function fromContribGuia(contrib, guiaLike) {
  // guiaLike pode vir nos dois jeitos; convertemos para a receita única esperada
  const mes = guiaLike.competencia?.mes ?? Number(String(guiaLike.mes_referencia || guiaLike.mes).replace(/\D/g, ''));
  const ano = guiaLike.competencia?.ano ?? Number(String(guiaLike.ano_referencia || guiaLike.ano).replace(/\D/g, ''));
  const venc = guiaLike.dataVencimento || guiaLike.data_vencimento;

  const codigo = guiaLike.codigo || guiaLike.codigo_receita;

  const valorPrincipal = Number(
    guiaLike.valorPrincipal != null ? guiaLike.valorPrincipal : guiaLike.valor
  );

  return normalizePayload({
    contribuinteEmitente: {
      codigoTipoInscricao: contrib.codigoTipoInscricao,
      numeroInscricao: String(contrib.numeroInscricao).replace(/\D/g, ''),
      nome: contrib.nome,
      codigoIbgeMunicipio: contrib.codigoIbgeMunicipio || 2704302,
    },
    receitas: [{
      codigo,
      competencia: { mes, ano },
      valorPrincipal,
      valorDesconto: Number(guiaLike.valorDesconto || 0),
      dataVencimento: String(venc).slice(0, 10),
    }],
    dataLimitePagamento: String(venc).slice(0, 10),
    observacao: guiaLike.observacao || '',
  });
}

async function emitirComPayload(payload) {
  // Se houver algum executor interno legado, use-o aqui:
  if (typeof emitirGuiaSefazComPayload === 'function') {
    return await emitirGuiaSefazComPayload(payload);
  }
  if (typeof emitirGuiaViaApp === 'function') {
    return await emitirGuiaViaApp(payload);
  }

  // Fallback HTTP direto (ajuste se sua URL/rota for outra)
  const baseURL =
    process.env.SEFAZ_APP_URL ||
    process.env.SEFAZ_BASE_URL ||
    process.env.SEFAZ_API_URL;
  const token = process.env.SEFAZ_APP_TOKEN || process.env.SEFAZ_TOKEN;

  if (!baseURL || !token) {
    throw new Error('Config SEFAZ ausente: defina SEFAZ_APP_URL/SEFAZ_BASE_URL e SEFAZ_APP_TOKEN.');
  }

  // Ex.: POST {baseURL}/guias/emitir  (AJUSTE A ROTA CONFORME O SEU BACKEND/PROXY)
  const url = `${baseURL.replace(/\/+$/, '')}/guias/emitir`;

  const { data } = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  // Normaliza campos de retorno
  return {
    numeroGuia: data.numeroGuia || data.numero || data.guiaNumero || data.id || null,
    pdfBase64: data.pdfBase64 || data.pdf || data.pdf_b64 || null,
    linhaDigitavel: data.linhaDigitavel || data.linha_digitavel || null,
    codigoBarras: data.codigoBarras || data.codigo_barras || null,
  };
}

async function emitirGuiaSefaz(...args) {
    // 1) payload único
  if (args.length === 1 && isPayload(args[0])) {
    const payload = normalizePayload(args[0]);
    return await emitirComPayload(payload); // sua função interna atual
  }

  // 2) dois argumentos (contribuinte, guiaLike)
  if (args.length === 2 && isContrib(args[0]) && isGuiaLike(args[1])) {
    const payload = fromContribGuia(args[0], args[1]); // monta payload único
    return await emitirComPayload(payload);
  }

  throw new Error('emitirGuiaSefaz: chame com payload pronto ou (contribuinte, guiaLike).');
}

function isContrib(c){
  return c && (c.codigoTipoInscricao===3 || c.codigoTipoInscricao===4)
     && typeof c.numeroInscricao === 'string'
     && c.numeroInscricao.replace(/\D/g,'').length>=11
     && c.codigoIbgeMunicipio;
}

function isGuiaLike(g){
  return g && (g.codigo || g.codigo_receita)
     && ((g.competencia && (g.competencia.mes && g.competencia.ano))
         || (g.mes_referencia && g.ano_referencia))
     && (g.dataVencimento || g.data_vencimento)
     && (g.valorPrincipal != null || g.valor != null);
}

function isPayload(p){
  return p && p.contribuinteEmitente && Array.isArray(p.receitas) && p.receitas.length>0;
}

function fromContribGuia(c, g){
  const mes = g.competencia?.mes ?? g.mes_referencia;
  const ano = g.competencia?.ano ?? g.ano_referencia;
  const codigo = g.codigo ?? g.codigo_receita;
  const valorPrincipal = Number(g.valorPrincipal ?? g.valor);
  const dataVencimento = g.dataVencimento ?? g.data_vencimento;
  const dataLimite = g.dataLimitePagamento ?? g.data_vencimento ?? g.dataVencimento ?? dataVencimento;
  return {
    contribuinteEmitente: {
      codigoTipoInscricao: Number(c.codigoTipoInscricao),
      numeroInscricao: String(c.numeroInscricao).replace(/\D/g,''),
      nome: c.nome,
      codigoIbgeMunicipio: c.codigoIbgeMunicipio
    },
    receitas: [{
      codigo,
      competencia: { mes: Number(mes), ano: Number(ano) },
      valorPrincipal,
      valorDesconto: Number(g.valorDesconto ?? 0),
      dataVencimento
    }],
    dataLimitePagamento: dataLimite,
    observacao: g.observacao || ''
  };
}

function normalizePayload(p){
  // garanta numeroInscricao sem máscara e numero/mes/ano numéricos
  const c = p.contribuinteEmitente || {};
  const r = (p.receitas || [])[0] || {};
  return {
    contribuinteEmitente: {
      codigoTipoInscricao: Number(c.codigoTipoInscricao),
      numeroInscricao: String(c.numeroInscricao || '').replace(/\D/g,''),
      nome: c.nome,
      codigoIbgeMunicipio: c.codigoIbgeMunicipio
    },
    receitas: [{
      codigo: r.codigo,
      competencia: { mes: Number(r.competencia?.mes), ano: Number(r.competencia?.ano) },
      valorPrincipal: Number(r.valorPrincipal),
      valorDesconto: Number(r.valorDesconto ?? 0),
      dataVencimento: r.dataVencimento
    }],
    dataLimitePagamento: p.dataLimitePagamento || r.dataVencimento,
    observacao: p.observacao || ''
  };
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

const getNumeroInscricao = (it) => onlyDigits(
  it.numeroInscricao
  || it.contribuintePagador?.numeroInscricao
  || it.contribuinteEmitente?.numeroInscricao
  || it.pagador?.numeroInscricao
  || it.contribuinte?.numeroInscricao
  || ''
);

const getValorPago = (it) => Number(
  it.valorPago ?? it.valorTotal ?? it.valor ?? it.valorPrincipal ?? 0
);

function mapPagamento(it) {
  return {
    numeroGuia: String(it.numeroGuia || it.numGuia || '').trim() || null,
    codigoBarras: String(it.numCodigoBarras || it.codigoBarras || '').trim() || null,
    linhaDigitavel: String(it.linhaDigitavel || '').trim() || null,
    dataPagamento: it.dataPagamento || it.dtPagamento || null,
    valorPago: getValorPago(it),
    numeroDocOrigem: it.numeroDocumentoOrigem || it.numeroDocOrigem || null,
    numeroInscricao: getNumeroInscricao(it),
    raw: it,
  };
}

async function listarPagamentosPorDataArrecadacao(dataInicioISO, dataFimISO, codigoReceita) {
  const payload = { dataInicioArrecadacao: dataInicioISO, dataFimArrecadacao: dataFimISO };
  // Se quiser filtrar por receita (recomendado quando você já itera por código):
  if (codigoReceita) payload.codigoReceita = normalizeCodigoReceita(codigoReceita);

  const { data } = await reqWithRetry(
    () => sefaz.post('/api/public/v2/guia/pagamento/por-data-arrecadacao', payload),
    'pagamento/por-data-arrecadacao'
  );

  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.map(mapPagamento);
}

async function listarPagamentosPorDataInclusao(dataInicioDateTime, dataFimDateTime, codigoReceita) {
  const payload = {
    dataHoraInicioInclusao: dataInicioDateTime,
    dataHoraFimInclusao:    dataFimDateTime,
  };
  if (codigoReceita) payload.codigoReceita = normalizeCodigoReceita(codigoReceita);

  const { data } = await reqWithRetry(
    () => sefaz.post('/api/public/v2/guia/pagamento/por-data-inclusao', payload),
    'pagamento/por-data-inclusao'
  );

  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.map(mapPagamento);
}

// Função de retry voltando ao normal, sem o log de depuração gigante
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
