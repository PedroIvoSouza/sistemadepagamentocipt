// src/utils/emailDestino.js
/**
 * Retorna o melhor e-mail para notificação:
 * 1) email_notificacao  2) email_financeiro  3) email
 */
function escolherEmailDestino(perm = {}) {
  const cand = [
    perm.email_notificacao,
    perm.email_financeiro,
    perm.email
  ].map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);

  return cand[0] || null;
}

module.exports = { escolherEmailDestino };