// Em: src/services/eventoValorService.js

/**
 * Contém a lógica de negócios para calcular os valores dos eventos
 * com base na tabela de descontos progressivos e descontos por tipo de cliente.
 */

// Preços base por diária, conforme a tabela
const precosPorDia = [
    2495.00, // 1ª diária
    1996.00, // 2ª diária
    1596.80, // 3ª diária
    1277.44, // 4ª diária
    1277.44  // 5ª diária em diante (com 20% de desconto sobre a 4ª) - A tabela já reflete isso.
];

/**
 * Calcula o valor bruto total de um evento com base no número de diárias.
 * @param {number} totalDiarias - O número total de dias do evento.
 * @returns {number} O valor bruto total.
 */
function calcularValorBruto(totalDiarias) {
    if (totalDiarias <= 0) return 0;

    let valorTotal = 0;
    if (totalDiarias >= 1) valorTotal += precosPorDia[0];
    if (totalDiarias >= 2) valorTotal += precosPorDia[1];
    if (totalDiarias >= 3) valorTotal += precosPorDia[2];
    if (totalDiarias >= 4) {
        // A partir da 4ª diária, o preço é fixo
        const diariasRestantes = totalDiarias - 3;
        valorTotal += diariasRestantes * precosPorDia[3];
    }
    
    // Arredonda para 2 casas decimais para evitar problemas de ponto flutuante
    return parseFloat(valorTotal.toFixed(2));
}

/**
 * Calcula o valor final de um evento aplicando os descontos.
 * @param {number} valorBruto - O valor bruto do evento.
 * @param {string} tipoCliente - 'Geral', 'Governo' ou 'Permissionario'.
 * @param {number} descontoManualPercent - Um percentual de desconto manual (ex: 10 para 10%).
 * @returns {number} O valor final a ser pago.
 */
function calcularValorFinal(valorBruto, tipoCliente, descontoManualPercent = 0) {
    let valorComDesconto = valorBruto;

    // 1. Aplica o desconto automático por tipo de cliente
    if (tipoCliente === 'Governo') {
        valorComDesconto *= 0.80; // 20% de desconto
    } else if (tipoCliente === 'Permissionario') {
        // Conforme a tabela, o desconto para permissionário é de 60% sobre o total
        valorComDesconto *= 0.40; // 60% de desconto
    }

    // 2. Aplica o desconto manual sobre o valor já com o desconto automático
    if (descontoManualPercent > 0) {
        valorComDesconto *= (1 - (descontoManualPercent / 100));
    }

    return parseFloat(valorComDesconto.toFixed(2));
}

module.exports = {
    calcularValorBruto,
    calcularValorFinal
};