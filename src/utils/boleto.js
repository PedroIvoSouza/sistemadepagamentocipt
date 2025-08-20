function codigoBarrasParaLinhaDigitavel(codigo='') {
  const digits = String(codigo).replace(/\D/g, '');
  if (digits.length !== 44) return '';
  const bloco1 = digits.slice(0, 4) + digits.slice(19, 24);
  const bloco2 = digits.slice(24, 34);
  const bloco3 = digits.slice(34, 44);
  const bloco4 = digits[4];
  const bloco5 = digits.slice(5, 19);
  const mod10 = str => {
    let soma = 0;
    let peso = 2;
    for (let i = str.length - 1; i >= 0; i--) {
      const n = parseInt(str[i], 10) * peso;
      soma += Math.floor(n / 10) + (n % 10);
      peso = peso === 2 ? 1 : 2;
    }
    const dig = (10 - (soma % 10)) % 10;
    return String(dig);
  };
  const campo1 = bloco1 + mod10(bloco1);
  const campo2 = bloco2 + mod10(bloco2);
  const campo3 = bloco3 + mod10(bloco3);
  return `${campo1}${campo2}${campo3}${bloco4}${bloco5}`;
}
module.exports = { codigoBarrasParaLinhaDigitavel };
