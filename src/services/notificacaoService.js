// src/services/notificacaoService.js
const { enviarEmailNotificacaoDar, enviarEmailNovaDar, enviarEmailDarAdvertencia } = require('./emailService');
const { escolherEmailDestino } = require('../utils/emailDestino');

/**
 * Envia e-mail sobre DAR (com fallback):
 * email_notificacao -> email_financeiro -> email (cadastro)
 *
 * @param {object} perm   row de permissionarios
 * @param {object} dar    row de dars
 * @param {object} opts   { tipo: 'novo' | 'notificar' }
 * @returns {boolean} true se enviou, false se não encontrou e-mail
 */
async function notificarDarGerado(perm, dar, opts = { tipo: 'notificar' }) {
  const emailParaEnvio = escolherEmailDestino(perm);
  if (!emailParaEnvio) return false;

  const dadosDoDar = {
    nome_empresa: perm.nome_empresa,
    mes_referencia: dar.mes_referencia,
    ano_referencia: dar.ano_referencia,
    valor: Number(dar.valor || 0),
    data_vencimento: dar.data_vencimento
  };

  if (opts.tipo === 'novo') {
    await enviarEmailNovaDar(emailParaEnvio, dadosDoDar);
  } else if (opts.tipo === 'advertencia') {
    const fatosList = Array.isArray(opts.fatos)
      ? opts.fatos.filter((f) => String(f || '').trim()).map((f) => String(f).trim())
      : [];
    const advertenciaDados = {
      nome_empresa: perm.nome_empresa,
      data_vencimento: dar.data_vencimento,
      valor: Number(dar.valor || 0),
      fatos: fatosList.length ? fatosList : (String(dar.advertencia_fatos || '').split(/\r?\n/).map((f) => f.trim()).filter(Boolean))
    };
    await enviarEmailDarAdvertencia(emailParaEnvio, advertenciaDados);
  } else {
    // monta payload esperado por enviarEmailNotificacaoDar
    const dadosEmail = {
      nome_empresa: perm.nome_empresa,
      competencia: `${String(dar.mes_referencia).padStart(2, '0')}/${dar.ano_referencia}`,
      valor: Number(dar.valor || 0),
      data_vencimento: dar.data_vencimento
    };
    await enviarEmailNotificacaoDar(emailParaEnvio, dadosEmail);
  }
  return true;
}

module.exports = { notificarDarGerado };
