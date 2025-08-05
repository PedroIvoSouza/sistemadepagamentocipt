// Em: src/services/cobrancaService.js

const axios = require('axios');

// Função principal que recebe um DAR vencido e retorna os valores atualizados
async function calcularEncargosAtraso(dar) {
    // Se o DAR não estiver vencido, não faz nada e retorna os valores originais
    if (dar.status !== 'Vencido') {
        return {
            valorOriginal: dar.valor,
            multa: 0,
            juros: 0,
            diasAtraso: 0,
            valorAtualizado: dar.valor
        };
    }

    // --- 1. CÁLCULO DA MULTA DE 2% ---
    const multa = dar.valor * 0.02;

    // --- 2. CÁLCULO DOS DIAS EM ATRASO ---
    const dataVencimento = new Date(dar.data_vencimento);
    const hoje = new Date();
    // Adicionamos 1 dia ao vencimento para a contagem começar no dia seguinte ao vencimento
    const inicioAtraso = new Date(dataVencimento.setDate(dataVencimento.getDate() + 1));
    const diffTempo = Math.abs(hoje - inicioAtraso);
    const diasAtraso = Math.ceil(diffTempo / (1000 * 60 * 60 * 24));

    // --- 3. CÁLCULO DOS JUROS (SELIC) ---
    let juros = 0;
    try {
        // Busca a taxa SELIC atual de uma API pública e confiável (BrasilAPI)
        const response = await axios.get('https://brasilapi.com.br/api/taxas/v1/selic');
        const selicAnual = response.data.valor; // A API retorna o valor anual, ex: 10.5

        // Converte a taxa anual para uma taxa diária
        const selicDiaria = (selicAnual / 100) / 365;

        // Calcula os juros: (Valor Original * Taxa Diária * Dias em Atraso)
        juros = dar.valor * selicDiaria * diasAtraso;

    } catch (error) {
        console.error("Erro ao buscar a taxa SELIC. Os juros não serão calculados.", error.message);
        // Em caso de falha na API, os juros não são aplicados, mas o resto funciona.
        juros = 0;
    }

    // --- 4. CÁLCULO DO VALOR FINAL ---
    const valorAtualizado = dar.valor + multa + juros;

    // Retorna um objeto com todos os detalhes do cálculo
    return {
        valorOriginal: dar.valor,
        multa: multa,
        juros: juros,
        diasAtraso: diasAtraso,
        valorAtualizado: valorAtualizado
    };
}

// Exporta a função para ser usada por outras partes do sistema
module.exports = { calcularEncargosAtraso };