// src/utils/boleto.js
function onlyDigits(s = '') {
  return String(s).replace(/\D/g, '');
}

/** Mod 10 genérico (boleto e arrecadação ref 6/7) */
function dvMod10(numStr) {
  let soma = 0, peso = 2;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = parseInt(numStr[i], 10) * peso;
    if (n > 9) n = Math.floor(n / 10) + (n % 10);
    soma += n;
    peso = (peso === 2) ? 1 : 2;
  }
  const dv = (10 - (soma % 10)) % 10;
  return String(dv);
}

/** Mod 11 específico de ARRECADAÇÃO (pesos 2..9 da direita p/ esquerda; 0/10/11 -> 0) */
function dvMod11Arrecadacao(numStr) {
  let soma = 0, peso = 2;
  for (let i = numStr.length - 1; i >= 0; i--) {
    soma += parseInt(numStr[i], 10) * peso;
    peso = (peso === 9) ? 2 : peso + 1;
  }
  let dv = 11 - (soma % 11);
  if (dv === 0 || dv === 10 || dv === 11) dv = 0;
  return String(dv);
}

/** 44 -> 47 (boleto bancário – mesmo raciocínio que você já usava) */
function boleto44To47(bar44) {
  const b = onlyDigits(bar44);
  if (b.length !== 44 || b[0] === '8') return null;

  const bloco1 = b.slice(0, 4) + b.slice(19, 24); // banco+moeda + livre[0..4]
  const bloco2 = b.slice(24, 34);                 // livre[5..14]
  const bloco3 = b.slice(34, 44);                 // livre[15..24]
  const bloco4 = b[4];                            // DV geral (posição 5)
  const bloco5 = b.slice(5, 19);                  // fator+valor (6..19)

  const campo1 = bloco1 + dvMod10(bloco1);
  const campo2 = bloco2 + dvMod10(bloco2);
  const campo3 = bloco3 + dvMod10(bloco3);

  return `${campo1}${campo2}${campo3}${bloco4}${bloco5}`;
}

/** 44 -> 48 (arrecadação/convênios – começa com '8') */
function arrecadacao44To48(bar44) {
  const b = onlyDigits(bar44);
  if (b.length !== 44 || b[0] !== '8') return null;

  // 4 blocos de 11 + DV por bloco
  const blk1 = b.slice(0, 11);
  const blk2 = b.slice(11, 22);
  const blk3 = b.slice(22, 33);
  const blk4 = b.slice(33, 44);

  // Dígito-referência (3º dígito) define o módulo: 6/7 -> mod10, 8/9 -> mod11
  const ref = b[2];
  const useMod10 = ref === '6' || ref === '7';
  const dvFn = useMod10 ? dvMod10 : dvMod11Arrecadacao;

  const dv1 = dvFn(blk1);
  const dv2 = dvFn(blk2);
  const dv3 = dvFn(blk3);
  const dv4 = dvFn(blk4);

  return blk1 + dv1 + blk2 + dv2 + blk3 + dv3 + blk4 + dv4;
}

/**
 * Normaliza um código (44/47/48) para LINHA DIGITÁVEL:
 * - 47 (boleto) -> 47
 * - 48 iniciando com '8' (arrecadação) -> 48
 * - 44 '8...' -> 48 (arrecadação)
 * - 44 'não 8' -> 47 (boleto)
 * Caso contrário, retorna string vazia para manter compatibilidade com seu código atual.
 */
function codigoBarrasParaLinhaDigitavel(codigo = '') {
  const d = onlyDigits(codigo);
  if (!d) return '';

  if (d.length === 47) return d;               // já é linha (boleto)
  if (d.length === 48 && d[0] === '8') return d; // já é linha (arrecadação)

  if (d.length === 44 && d[0] === '8') {
    return arrecadacao44To48(d) || '';
  }

  if (d.length === 44 && d[0] !== '8') {
    return boleto44To47(d) || '';
  }

  return '';
}

/** 48 (arrecadação) -> 44 (removendo DVs de cada bloco) */
function linha48ToCodigo44(ld48 = '') {
  const d = onlyDigits(ld48);
  if (d.length !== 48 || d[0] !== '8') return '';
  const b1 = d.slice(0, 12);
  const b2 = d.slice(12, 24);
  const b3 = d.slice(24, 36);
  const b4 = d.slice(36, 48);
  return b1.slice(0, 11) + b2.slice(0, 11) + b3.slice(0, 11) + b4.slice(0, 11);
}

/** 47 (boleto) -> 44 (layout FEBRABAN) */
function linha47ToCodigo44(ld47 = '') {
  const d = onlyDigits(ld47);
  if (d.length !== 47) return '';
  const c1 = d.slice(0, 9);
  const c2 = d.slice(10, 20);
  const c3 = d.slice(21, 31);
  const dvGeral = d.slice(32, 33);
  const fatorValor = d.slice(33, 47);
  const bancoMoeda = c1.slice(0, 4);
  const campoLivre = c1.slice(4, 9) + c2 + c3;
  return bancoMoeda + dvGeral + fatorValor + campoLivre;
}

/**
 * Inverte `codigoBarrasParaLinhaDigitavel`: converte uma linha digitável (47/48)
 * em código de barras (44). Caso não seja possível converter, retorna string vazia.
 */
function linhaDigitavelParaCodigoBarras(linha = '') {
  const d = onlyDigits(linha);
  if (!d) return '';

  if (d.length === 44) return d; // já é código de barras
  if (d.length === 48 && d[0] === '8') return linha48ToCodigo44(d) || '';
  if (d.length === 47) return linha47ToCodigo44(d) || '';
  return '';
}

module.exports = { codigoBarrasParaLinhaDigitavel, linhaDigitavelParaCodigoBarras };
