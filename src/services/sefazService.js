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
  SEFAZ_TIMEOUT_MS = '120000',  // 120s
  SEFAZ_RETRIES = '5',          // 1 tentativa + 5 retries
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
   proxy: false, // <<< ignora HTTP(S)_PROXY do ambiente para SEFAZ
   headers: {
     'Content-Type': 'application/json',
     Accept: 'application/json',
     // highlight-next-line
     'appToken': getAppTokenStrict(), // <<< ADICIONAR ESTA LINHA
   },
});


// ==========================
// Helpers
// ==========================

function cleanHeaderValue(s) {
  return (s ?? '').toString().replace(/[\r\n]/g, '').trim();
}

function getAppTokenStrict() {
  const v = cleanHeaderValue(process.env.SEFAZ_APP_TOKEN);
  if (!v) throw new Error('SEFAZ_APP_TOKEN não configurado no .env.');
  if (/[\u0000-\u001F\u007F]/.test(v)) throw new Error('SEFAZ_APP_TOKEN contém caracteres de controle');
  return v;
}

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
  dataVencimentoISO,     // YYYY-MM-DD
  dataLimiteISO,         // YYYY-MM-DD (opcional, será clampado)
  observacao,
  docOrigem,             // opcional: { codigo: <int>, numero: <string> }
}) {
  // valida o token em runtime
  getAppTokenStrict();

  const numeroInscricao = onlyDigits(documento || cnpj || '');
  const len = numeroInscricao.length;

  // Mapeamento padrão usado por essa API: 1=CPF, 4=CNPJ
  const TIPO_INSCRICAO = { CPF: 3, CNPJ: 4 };
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
      codigoTipoInscricao,     // agora dinâmico
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
  if (docDigits.length === 11) {
    const cod = normalizeCodigoReceita(process.env.RECEITA_CODIGO_EVENTO_PF || process.env.RECEITA_CODIGO_EVENTO);
    if (!cod) throw new Error('Código de receita de EVENTO para PF não configurado. Defina RECEITA_CODIGO_EVENTO_PF.');
    return cod;
  }
  if (docDigits.length === 14) {
    const cod = normalizeCodigoReceita(process.env.RECEITA_CODIGO_EVENTO_PJ || process.env.RECEITA_CODIGO_EVENTO || process.env.RECEITA_CODIGO_PERMISSIONARIO);
    if (!cod) throw new Error('Código de receita de EVENTO para PJ não configurado. Defina RECEITA_CODIGO_EVENTO_PJ.');
    return cod;
  }
  throw new Error('Documento inválido para evento (CPF 11 dígitos ou CNPJ 14).');
}


/**
 * Permissionários (aluguel)
 *   perm: { cnpj, nome_empresa }
 *   darLike: { valor, data_vencimento, mes_referencia, ano_referencia, id? }
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
    documento,                                // 👈 agora definido
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo: receitaCodigo || RECEITA_CODIGO_PERMISSIONARIO,
    competenciaMes: mes,
    competenciaAno: ano,
    valorPrincipal: valor,
    dataVencimentoISO: dataVencISO,
    dataLimiteISO: dataVencISO,               // será clampado >= hoje
    observacao: `Aluguel CIPT - ${nome}`,
    docOrigem,
  });
}

/**
 * Eventos (se usar receita distinta)
 *   cliente: { cnpj, nome_razao_social }
 *   parcela: { valor, vencimento, competenciaMes, competenciaAno, id? }
 */
function buildSefazPayloadEvento({ cliente, parcela, receitaCodigo }) {
  const doc = onlyDigits(cliente?.cnpj || cliente?.documento || '');
  const nome = cliente?.nome_razao_social || cliente?.nome || 'Contribuinte';
  const valor = Number(parcela?.valor || parcela?.valorPrincipal || 0);
  const dataVencISO = toISO(parcela?.vencimento || parcela?.data_vencimento);
  const mes = Number(parcela?.competenciaMes || parcela?.mes || 0);
  const ano = Number(parcela?.competenciaAno || parcela?.ano || 0);

  // Escolha automática da receita por tipo de inscrição:
  let receitaPorTipo = receitaCodigo; // permite override explícito
  if (!receitaPorTipo) {
    if (doc.length === 11) {
      receitaPorTipo = RECEITA_CODIGO_EVENTO_PF || RECEITA_CODIGO_EVENTO;
    } else if (doc.length === 14) {
      receitaPorTipo = RECEITA_CODIGO_EVENTO_PJ || RECEITA_CODIGO_EVENTO || RECEITA_CODIGO_PERMISSIONARIO;
    }
  }

  if (!receitaPorTipo) {
    throw new Error(
      `Código de receita de evento não configurado para o tipo de inscrição (${doc.length===11?'CPF':'CNPJ'}). ` +
      `Defina RECEITA_CODIGO_EVENTO_${doc.length===11?'PF':'PJ'} no .env.`
    );
  }

  const docOrigem = DOC_ORIGEM_COD
    ? { codigo: Number(DOC_ORIGEM_COD), numero: String(parcela?.id || parcela?.referencia || '') || String(Date.now()) }
    : null;

  return buildSefazPayload({
    documento: doc,
    nome,
    codIbgeMunicipio: COD_IBGE_MUNICIPIO,
    receitaCodigo: receitaPorTipo,      // << usa a receita compatível
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
async function emitirGuiaSefaz(arg1, arg2) {
   // payload pronto?
   if (arg1 && typeof arg1 === 'object' && arg1.versao && arg1.contribuinteEmitente && arg1.receitas) {
     return _postEmitir(arg1);
   }
   // Compat (contribuinte, guiaLike)
   if (arg1 && arg2) {
     const contrib = arg1 || {};
     const guia = arg2 || {};
    const doc = onlyDigits(contrib.documento || contrib.cnpj || contrib.cpf || '');
    const fakeDarLike = {
      valor: guia.valor || guia.valorPrincipal || 0,
      data_vencimento: guia.data_vencimento || guia.vencimento || guia.dataVencimento,
      mes_referencia: guia.mes_referencia || guia.competencia?.mes || guia.mes,
      ano_referencia: guia.ano_referencia || guia.competencia?.ano || guia.ano,
      id: guia.id || guia.referencia || null,
      numero_documento: guia.numero_documento || null,
    };
    if (doc.length === 14) {
      const payload = buildSefazPayloadPermissionario({
        perm: { cnpj: doc, nome_empresa: contrib.nomeRazaoSocial || contrib.nome },
        darLike: fakeDarLike,
        receitaCodigo: RECEITA_CODIGO_PERMISSIONARIO,
      });
      return _postEmitir(payload);
    }
    if (doc.length === 11) {
      const payload = buildSefazPayloadEvento({
        cliente: { documento: doc, nome_razao_social: contrib.nomeRazaoSocial || contrib.nome },
        parcela: {
          valor: fakeDarLike.valor,
          vencimento: fakeDarLike.data_vencimento,
          competenciaMes: fakeDarLike.mes_referencia,
          competenciaAno: fakeDarLike.ano_referencia,
          id: fakeDarLike.id,
        },
        // receitaCodigo opcional; pickReceitaEventoByDoc decide
      });
      return _postEmitir(payload);
    }
    throw new Error('Documento inválido (CPF 11 dígitos ou CNPJ 14).');
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
