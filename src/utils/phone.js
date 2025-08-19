// utils/phone.js
function normalizeMsisdn(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.slice(-11); // DDD + número
}
module.exports = { normalizeMsisdn };
