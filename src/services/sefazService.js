// src/services/sefazService.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const axios = require('axios');
const https = require('https');
const fs = require('fs');

/* ==========================
   TLS / CA
   ========================== */
const tlsInsecure = String(process.env.SEFAZ_TLS_INSECURE || '').toLowerCase() === 'true';

let extraCa;
try {
  if (!tlsInsecure && process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) {
    extraCa = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS);
  }
} catch { /* noop */ }

const httpsAgent = new https.Agent({
  // quando SEFAZ_TLS_INSECURE=true, NÃO rejeita cert inválido
  rejectUnauthorized: !tlsInsecure,
  ca: tlsInsecure ? undefined : extraCa,
});

/* ==========================
   ENV
   ========================== */
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
  SEFAZ_HEALTHCHECK_RECEITA_CODIGO,
  DOC_ORIGEM_COD,                 // opcional (se a receita exigir documento de origem)
  SEFAZ_TIMEOUT_MS = '120000',    // 120s
  SEFAZ_RETRIES = '5',            // 1 tentativa + 5 retries
} = process.env;

// Log rápido de conferência
console.log('\n--- VERIFICANDO VARIÁVEIS DE AMBIENTE CARREGADAS ---');
console.log(`SEFAZ_MODE: [${process.env.SEFAZ_MODE}]`);
console.log(`SEFAZ_TLS_INSECURE: [${process.env.SEFAZ_TLS_INSECURE}]`);
console.log(`SEFAZ_APP_TOKEN (primeiros 5): [${String(process.env.SEFAZ_APP_TOKEN || '').slice(0, 5)}...]`);
console.log('----------------------------------------------------\n');

const BASE_URL = (SEFAZ_MODE || 'hom').toLowerCase() === 'prod'
  ? SEFAZ_API_URL_PROD
  : SEFAZ_API_URL_HOM;

/* ==========================
   AXIOS (instância oficial SEFAZ)
   ========================== */
const sefaz = axios.create({
  baseURL: BASE_URL,
  timeout: Number(SEFAZ_TIMEOUT_MS || 120000),
  httpsAgent,
  proxy: false,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    appToken: getAppTokenStrict(), // função abaixo (hoisted)
  },
});

// Mapa de tipo de inscrição da API
const TIPO_INSCRICAO = { CPF: 3, CNPJ: 4 };

/* ==========================================
   INTERCEPTOR de debug
   ========================================== */
sefaz.interceptors.request.use((request) => {
  const maskedHeaders = { ...request.headers };
  if (maskedHeaders && maskedHeaders.appToken) {
    const t = String(maskedHeaders.appToken);
    maskedHeaders.appToken = t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '***';
  }

  console.log('\n--- AXIOS REQUEST INTERCEPTOR ---');
  console.log(`- Método: ${String(request.method || '').toUpperCase()}`);
  console.log(`- URL Base: ${request.baseURL}`);
  console.log(`- Caminho: ${request.url}`);
  console.log(`- URL Completa: ${request.baseURL}${request.url}`);
  console.log('- Headers:', JSON.stringify(maskedHeaders, null, 2));
  if (request.data) console.log('- Corpo (Payload):', JSON.stringify(request.data, null, 2));
  console.log('---------------------------------\n');
  return request;
}, (error) => Promise.reject(error));

/* ==========================
   Helpers
   ========================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_CONSULTA_INTERVAL_MS = (() => {
  const parsed = Number(process.env.SEFAZ_MIN_CONSULTA_INTERVAL_MS ?? 180000);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 180000;
})();

let nextConsultaDisponivel = 0;
let consultaFila = Promise.resolve();

async function agendarConsulta(fn, label = 'consulta-sefaz') {
  const executar = async () => {
    while (true) {
      const agora = Date.now();
      const espera = nextConsultaDisponivel - agora;
      if (espera <= 0) break;
      console.log(`[SEFAZ][${label}] aguardando ${espera}ms para respeitar intervalo mínimo.`);
      await sleep(espera);
    }

    try {
      return await fn();
    } finally {
      nextConsultaDisponivel = Date.now() + MIN_CONSULTA_INTERVAL_MS;
    }
  };

  const promessa = consultaFila.then(executar);
  consultaFila = promessa.catch(() => {});
  return promessa;
}

function cleanHeaderValue(s) {
  return (s ?? '').toString().replace(/[\r\n]/g, '').trim();
}

function getAppTokenStrict() {
  const v = cleanHeaderValue(SEFAZ_APP_TOKEN);
  if (!v) throw new Error('SEFAZ_APP_TOKEN não configurado no .env.');
  if (/[\u0000-\u001F\u007F]/.test(v)) throw new Error('SEFAZ_APP_TOKEN contém caracteres de controle.');
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

      // Loga corpo de erro da API (quando houver)
      if (err.response) {
        console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(`[SEFAZ][${label}] ERRO DA API (Status: ${err.response.status})`);
        console.error(`[SEFAZ][${label}] RESPOSTA:`, JSON.stringify(err.response.data, null, 2));
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
      }

      const isTimeout = err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '');
      const noResp = !err?.response;
      const retriable = [429, 502, 503, 504].includes(err?.response?.status);

      if (attempt < maxRetries && (isTimeout || noResp || retriable)) {
        const delay = Math.min(30000, 1000 * (2 ** attempt)); // 1s,2s,4s,8s,16s,30s
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

function toISO(d) {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function clampDataLimitePagamento(dataVencimentoISO, dataLimiteISO) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const lim = toISO(dataLimiteISO) || toISO(dataVencimentoISO) || hojeISO;
  return lim < hojeISO ? hojeISO : lim;
}

/** Normaliza código da receita (remove DV e não-dígitos). */
function normalizeCodigoReceita(cod) {
  const num = onlyDigits(cod);
  if (!num) return 0;
  // 5 dígitos + 1 DV → se tiver 6, corta o DV
  if (num.length === 6 && /^[1-9]\d{4}\d$/.test(num)) return Number(num.slice(0, 5));
  return Number(num);
}

/* ==========================
   Builders de Payload
   ========================== */
/** Monta payload “oficial” aceitando CPF/CNPJ. */
function buildSefazPayload({
  documento,
  cnpj, // retrocompat
  nome,
  codIbgeMunicipio,
  receitaCodigo,
  competenciaMes,
  competenciaAno,
  valorPrincipal,
  dataVencimentoISO, // YYYY-MM-DD
  dataLimiteISO,     // YYYY-MM-DD
  observacao,
  docOrigem,         // { codigo: <int>, numero: <string> } (opcional)
}) {
  getAppTokenStrict(); // sanity

  const numeroInscricao = onlyDigits(documento || cnpj || '');
  const len = numeroInscricao.length;

  let codigoTipoInscricao;
  if (len === 11) codigoTipoInscricao = TIPO_INSCRICAO.CPF;
  else if (len === 14) codigoTipoInscricao = TIPO_INSCRICAO.CNPJ;
  else throw new Error('Documento do emitente inválido (CPF 11 dígitos ou CNPJ 14).');

  const receitaCod = normalizeCodigoReceita(receitaCodigo);
  if (!receitaCod) throw new Error('Código de receita inválido/ausente.');

  const mes = Number(competenciaMes);
  const ano = Number(competenciaAno);
  if (!mes || !ano) throw new Error('Competência inválida (mês/ano).');

  const dataVenc = toISO(dataVencimentoISO);
  if (!dataVenc) throw new Error('dataVencimento inválida/ausente (YYYY-MM-DD).');

  const dataLimitePagamento = clampDataLimitePagamento(dataVenc, dataLimiteISO);

  const payload = {
    versao: '1.0', // 👈 OBRIGATÓRIO
    contribuinteEmitente: {
      codigoTipoInscricao,
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
    if (!cod) throw new Error('Código de receita de EVENTO para PF não configurado (RECEITA_CODIGO_EVENTO_PF).');
    return cod;
  }
  if (docDigits.length === 14) {
    const cod = normalizeCodigoReceita(receitaPJ);
    if (!cod) throw new Error('Código de receita de EVENTO para PJ não configurado (RECEITA_CODIGO_EVENTO_PJ).');
    return cod;
  }
  throw new Error('Documento inválido para evento (CPF 11 dígitos ou CNPJ 14).');
}

/** Permissionários (aluguel). */
function buildSefazPayloadPermissionario({ perm, darLike, receitaCodigo = RECEITA_CODIGO_PERMISSIONARIO }) {
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
    documento,
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo: receitaCodigo || RECEITA_CODIGO_PERMISSIONARIO,
    competenciaMes: mes,
    competenciaAno: ano,
    valorPrincipal: valor,
    dataVencimentoISO: dataVencISO,
    dataLimiteISO: dataVencISO,
    observacao: `Aluguel CIPT - ${nome}`,
    docOrigem,
  });
}

/** Eventos (receita distinta, se houver). */
function buildSefazPayloadEvento({ cliente, parcela, receitaCodigo }) {
  const doc = onlyDigits(cliente?.cnpj || cliente?.documento || '');
  const nome = cliente?.nome_razao_social || cliente?.nome || 'Contribuinte';
  const valor = Number(parcela?.valor || parcela?.valorPrincipal || 0);
  const dataVencISO = toISO(parcela?.vencimento || parcela?.data_vencimento);
  const mes = Number(parcela?.competenciaMes || parcela?.mes || 0);
  const ano = Number(parcela?.competenciaAno || parcela?.ano || 0);

  const receitaPorTipo = pickReceitaEventoByDoc(doc, receitaCodigo);

  const docOrigem = DOC_ORIGEM_COD
    ? { codigo: Number(DOC_ORIGEM_COD), numero: String(parcela?.id || parcela?.referencia || '') || String(Date.now()) }
    : null;

  return buildSefazPayload({
    documento: doc,
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo: receitaPorTipo,
    competenciaMes: mes,
    competenciaAno: ano,
    valorPrincipal: valor,
    dataVencimentoISO: dataVencISO,
    dataLimiteISO: dataVencISO,
    observacao: `Evento CIPT - ${nome}`,
    docOrigem,
  });
}

/* ==========================
   Emissão de Guia
   ========================== */
async function _postEmitir(payload) {
  // força limpeza de códigos e garante a estrutura
  if (!payload?.versao) payload.versao = '1.0';

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
          appToken: getAppTokenStrict(), // revalida aqui
          'Content-Type': 'application/json',
        },
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

/* ==========================
   Validações de chamada
   ========================== */
function isPayload(obj) {
  return obj && typeof obj === 'object'
    && obj.contribuinteEmitente
    && Array.isArray(obj.receitas)
    && obj.receitas.length > 0;
}

function isContrib(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const { codigoTipoInscricao, numeroInscricao, nome } = obj;
  return (codigoTipoInscricao === 3 || codigoTipoInscricao === 4)
    && typeof numeroInscricao === 'string'
    && numeroInscricao.replace(/\D/g, '').length > 0
    && typeof nome === 'string';
}

function isGuiaLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    (obj.codigo && obj.competencia && obj.dataVencimento && (obj.valorPrincipal ?? obj.valor)) ||
    (obj.data_vencimento && (obj.valor ?? obj.valorPrincipal))
  );
}

/* ==========================
   Normalizadores
   ========================== */
function normalizePayload(p) {
  const c0 = p.contribuinteEmitente || {};
  const r0 = (p.receitas || [])[0] || {};

  const r = {
    codigo: Number(String(r0.codigo).replace(/\D/g, '')),
    competencia: {
      mes: Number(r0.competencia?.mes),
      ano: Number(r0.competencia?.ano),
    },
    valorPrincipal: Number(r0.valorPrincipal ?? r0.valor),
    valorDesconto: Number(r0.valorDesconto ?? 0),
    dataVencimento: toISO(r0.dataVencimento),
  };
  const dataLimite = toISO(p.dataLimitePagamento) || r.dataVencimento;

  return {
    versao: p.versao || '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: Number(c0.codigoTipoInscricao),
      numeroInscricao: String(c0.numeroInscricao || '').replace(/\D/g, ''),
      nome: c0.nome,
      codigoIbgeMunicipio: Number(c0.codigoIbgeMunicipio || COD_IBGE_MUNICIPIO),
    },
    receitas: [r],
    dataLimitePagamento: dataLimite,
    observacao: (p.observacao || '').slice(0, 255),
  };
}

function fromContribGuia(c, g) {
  const mes = g.competencia?.mes ?? g.mes_referencia;
  const ano = g.competencia?.ano ?? g.ano_referencia;
  const codigo = g.codigo ?? g.codigo_receita;
  const valorPrincipal = Number(g.valorPrincipal ?? g.valor);
  const vencISO = toISO(g.dataVencimento ?? g.data_vencimento);
  const dataLimite = toISO(g.dataLimitePagamento) || vencISO;

  return normalizePayload({
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: Number(c.codigoTipoInscricao),
      numeroInscricao: String(c.numeroInscricao).replace(/\D/g, ''),
      nome: c.nome,
      codigoIbgeMunicipio: c.codigoIbgeMunicipio || COD_IBGE_MUNICIPIO,
    },
    receitas: [{
      codigo,
      competencia: { mes: Number(mes), ano: Number(ano) },
      valorPrincipal,
      valorDesconto: Number(g.valorDesconto ?? 0),
      dataVencimento: vencISO,
    }],
    dataLimitePagamento: dataLimite,
    observacao: g.observacao || '',
  });
}

/* ==========================
   API pública deste serviço
   ========================== */
async function emitirGuiaSefaz(...args) {
  // 1) payload único
  if (args.length === 1 && isPayload(args[0])) {
    const payload = normalizePayload(args[0]);
    return _postEmitir(payload);
  }
  // 2) dois argumentos (contribuinte, guiaLike)
  if (args.length === 2 && isContrib(args[0]) && isGuiaLike(args[1])) {
    const payload = fromContribGuia(args[0], args[1]);
    return _postEmitir(payload);
  }
  throw new Error('emitirGuiaSefaz: chame com payload pronto ou (contribuinte, guiaLike).');
}

/* ==========================
   Consultas
   ========================== */
async function consultarReceita(codigo) {
  const cod = normalizeCodigoReceita(codigo);
  try {
    const { data } = await agendarConsulta(
      () => reqWithRetry(
        () => sefaz.get('/api/public/receita/consultar', { params: { codigo: cod } }),
        'receita/consultar'
      ),
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
  if (codigoReceita) payload.codigoReceita = normalizeCodigoReceita(codigoReceita);

  const { data } = await agendarConsulta(
    () => reqWithRetry(
      () => sefaz.post('/api/public/v2/guia/pagamento/por-data-arrecadacao', payload),
      'pagamento/por-data-arrecadacao'
    ),
    'pagamento/por-data-arrecadacao'
  );

  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.map(mapPagamento);
}

async function consultarPagamentoPorCodigoBarras(numeroGuia, linhaDigitavel) {
  const payload = {};
  if (numeroGuia) payload.numeroGuia = onlyDigits(numeroGuia);
  if (linhaDigitavel) payload.linhaDigitavel = onlyDigits(linhaDigitavel);
  if (!payload.numeroGuia && !payload.linhaDigitavel) return null;

  const { data } = await agendarConsulta(
    () => reqWithRetry(
      () => sefaz.post('/api/public/v2/guia/pagamento/por-barras', payload),
      'pagamento/por-barras'
    ),
    'pagamento/por-barras'
  );

  const item = Array.isArray(data) ? data[0] : data;
  return item ? mapPagamento(item) : null;
}

async function listarPagamentosPorDataInclusao(dataInicioDateTime, dataFimDateTime, codigoReceita) {
  const payload = {
    dataHoraInicioInclusao: dataInicioDateTime,
    dataHoraFimInclusao:    dataFimDateTime,
  };
  if (codigoReceita) payload.codigoReceita = normalizeCodigoReceita(codigoReceita);

  const { data } = await agendarConsulta(
    () => reqWithRetry(
      () => sefaz.post('/api/public/v2/guia/pagamento/por-data-inclusao', payload),
      'pagamento/por-data-inclusao'
    ),
    'pagamento/por-data-inclusao'
  );

  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.map(mapPagamento);
}

async function checkSefazHealth() {
  const candidatos = [
    SEFAZ_HEALTHCHECK_RECEITA_CODIGO,
    RECEITA_CODIGO_PERMISSIONARIO,
    RECEITA_CODIGO_EVENTO,
    RECEITA_CODIGO_EVENTO_PF,
    RECEITA_CODIGO_EVENTO_PJ,
  ]
    .map((cod) => normalizeCodigoReceita(cod))
    .filter((cod) => Number.isFinite(cod) && cod > 0);

  if (!candidatos.length) {
    throw new Error('Nenhum código de receita configurado para health-check da SEFAZ.');
  }

  const codigo = Number(candidatos[0]);
  const { data } = await agendarConsulta(
    () => reqWithRetry(
      () => sefaz.get('/api/public/receita/consultar', { params: { codigo } }),
      'health-check'
    ),
    'health-check'
  );

  if (!data) {
    throw new Error('Resposta vazia da SEFAZ no health-check.');
  }

  return true;
}

/* ==========================
   Exports
   ========================== */
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
  consultarPagamentoPorCodigoBarras,
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
  checkSefazHealth,
};
