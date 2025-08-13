// src/utils/sefazPayload.js

const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

/** YYYY-MM-DD (hora local, evitando “voltar 1 dia” por UTC) */
function isoHojeLocal() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/** Aceita Date/string e retorna YYYY-MM-DD (ou null) em horário local */
function toISO(d) {
  if (!d) return null;
  if (d instanceof Date && !isNaN(d.getTime())) {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return null;
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * Monta o payload no formato esperado pela SEFAZ-AL.
 * Requer no .env:
 *  - COD_IBGE_MUNICIPIO
 *  - RECEITA_CODIGO_PERMISSIONARIO
 * (opcionais) ENDERECO_PADRAO, CEP_PADRAO
 */
function buildSefazPayloadPermissionario({ perm, darLike }) {
  const cnpj = onlyDigits(perm.cnpj || '');
  if (cnpj.length !== 14) throw new Error(`CNPJ inválido para o permissionário: ${perm.cnpj || 'vazio'}`);

  // vencimento do DAR
  let dataVenc = toISO(darLike.data_vencimento);
  if (!dataVenc) throw new Error(`Data de vencimento inválida: ${darLike.data_vencimento}`);

  // limite >= hoje
  const hoje = isoHojeLocal();
  const dataLimitePagamento = dataVenc < hoje ? hoje : dataVenc;

  // competência: preferir a referência do DAR, senão (mês/ano do vencimento)
  let compMes = Number(darLike.mes_referencia);
  let compAno = Number(darLike.ano_referencia);
  if (!compMes || !compAno) {
    const [yyyy, mm] = dataVenc.split('-');
    compMes = compMes || Number(mm);
    compAno = compAno || Number(yyyy);
  }

  const codigoIbge = Number(process.env.COD_IBGE_MUNICIPIO || 0);
  const receitaCod = Number(process.env.RECEITA_CODIGO_PERMISSIONARIO || 0);
  if (!codigoIbge) throw new Error('COD_IBGE_MUNICIPIO não configurado (.env).');
  if (!receitaCod) throw new Error('RECEITA_CODIGO_PERMISSIONARIO não configurado (.env).');

  // Endereço/CEP — fallbacks
  const descricaoEndereco =
    (perm.endereco && String(perm.endereco).trim()) ||
    (process.env.ENDERECO_PADRAO || 'R. Barão de Jaraguá, 590 - Jaraguá, Maceió/AL');
  const numeroCep =
    onlyDigits(perm.cep || '') ||
    onlyDigits(process.env.CEP_PADRAO || '57020000');

  const valorPrincipal = Number(darLike.valor || 0);
  if (!(valorPrincipal > 0)) throw new Error(`Valor do DAR inválido: ${darLike.valor}`);

  return {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: 4, // 3=CPF, 4=CNPJ
      numeroInscricao: cnpj,
      nome: perm.nome_empresa || 'Contribuinte',
      codigoIbgeMunicipio: codigoIbge,
      descricaoEndereco,
      numeroCep
    },
    receitas: [
      {
        codigo: receitaCod,
        competencia: { mes: compMes, ano: compAno },
        valorPrincipal,
        valorDesconto: 0.0,
        dataVencimento: dataVenc
      }
    ],
    dataLimitePagamento,
    observacao: `Aluguel CIPT - ${String(perm.nome_empresa || '').slice(0, 60)}`
  };
}

module.exports = { isoHojeLocal, toISO, buildSefazPayloadPermissionario };