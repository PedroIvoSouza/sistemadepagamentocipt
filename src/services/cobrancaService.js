// Em: src/services/cobrancaService.js
const axios = require('axios');

// --- NOVAS FUNÇÕES DE DATA (REUTILIZADAS DO CRON JOB) ---
function isFeriado(data) {
    const dia = String(data.getDate()).padStart(2, '0');
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dataStr = `${dia}/${mes}`;
    const feriadosFixos = ['01/01', '21/04', '01/05', '24/06', '07/09', '16/09', '12/10', '02/11', '15/11', '25/12'];
    return feriadosFixos.includes(dataStr);
}

function isDiaUtil(data) {
    const diaDaSemana = data.getDay();
    if (diaDaSemana === 0 || diaDaSemana === 6) return false;
    if (isFeriado(data)) return false;
    return true;
}

function getProximoDiaUtil(data) {
    let proximoDia = new Date(data);
    proximoDia.setDate(proximoDia.getDate() + 1);
    while (!isDiaUtil(proximoDia)) {
        proximoDia.setDate(proximoDia.getDate() + 1);
    }
    return proximoDia;
}
// -----------------------------------------------------------

async function calcularEncargosAtraso(dar) {
    const hoje = new Date();
    
    // --- LÓGICA DA NOVA DATA DE VENCIMENTO ---
    let novaDataVencimento = new Date(hoje);
    // Se for depois das 15h, ou se hoje não for dia útil, joga o vencimento para o próximo dia útil.
    if (hoje.getHours() >= 15 || !isDiaUtil(hoje)) {
        novaDataVencimento = getProximoDiaUtil(hoje);
    }
    // -----------------------------------------

    const dataVencimentoOriginal = new Date(dar.data_vencimento);
    
    // O cálculo de juros agora considera a diferença até a nova data de vencimento
    const diffTempo = Math.abs(novaDataVencimento - dataVencimentoOriginal);
    const diasAtraso = Math.ceil(diffTempo / (1000 * 60 * 60 * 24));

    if (diasAtraso <= 0) { // Se não estiver em atraso, retorna zerado
        return {
            valorOriginal: dar.valor, multa: 0, juros: 0, diasAtraso: 0,
            valorAtualizado: dar.valor,
            novaDataVencimento: novaDataVencimento.toISOString().split('T')[0]
        };
    }

    const multa = dar.valor * 0.02;
    let juros = 0;
    try {
        const response = await axios.get('https://brasilapi.com.br/api/taxas/v1/selic');
        const selicAnual = response.data[0].valor; 
        const selicDiaria = (selicAnual / 100) / 365;
        juros = dar.valor * selicDiaria * diasAtraso;
    } catch (error) {
        console.error("Erro ao buscar a taxa SELIC. Juros não serão calculados.", error.message);
        juros = 0;
    }

    const valorAtualizado = dar.valor + multa + juros;

    return {
        valorOriginal: dar.valor,
        multa: multa,
        juros: juros,
        diasAtraso: diasAtraso,
        valorAtualizado: valorAtualizado,
        novaDataVencimento: novaDataVencimento.toISOString().split('T')[0] // Retorna a nova data formatada
    };
}

module.exports = { calcularEncargosAtraso };