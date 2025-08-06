// Em: src/services/cobrancaService.js
const axios = require('axios');
const https = require('https');

// --- Funções de Data (sem alterações) ---
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
    // ... (lógica de data e multa continua a mesma) ...
    const hoje = new Date();
    
    let novaDataVencimento = new Date(hoje);
    if (hoje.getHours() >= 15 || !isDiaUtil(hoje)) {
        novaDataVencimento = getProximoDiaUtil(hoje);
    }

    const dataVencimentoOriginal = new Date(dar.data_vencimento);
    
    const diffTempo = Math.abs(novaDataVencimento - dataVencimentoOriginal);
    const diasAtraso = Math.ceil(diffTempo / (1000 * 60 * 60 * 24));

    if (diasAtraso <= 0) {
        return {
            valorOriginal: dar.valor, multa: 0, juros: 0, diasAtraso: 0,
            valorAtualizado: dar.valor,
            novaDataVencimento: novaDataVencimento.toISOString().split('T')[0]
        };
    }

    const multa = dar.valor * 0.02;
    let juros = 0;

    // --- BLOCO DE CÓDIGO FINAL E CORRIGIDO PARA BUSCAR A SELIC ---
    try {
        console.log('[INFO] Buscando taxa SELIC da API BrasilAPI...');
        
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });
        const url = 'https://brasilapi.com.br/api/taxas/v1/selic';

        const response = await axios.get(url, { httpsAgent, timeout: 15000 });

        // Verificação de segurança AJUSTADA para esperar um OBJETO, não um array.
        if (response && response.data && typeof response.data === 'object' && response.data.hasOwnProperty('valor')) {
            const selicAnual = parseFloat(response.data.valor); // Acessa o valor diretamente
            const selicDiaria = (selicAnual / 100) / 365;
            juros = dar.valor * selicDiaria * diasAtraso;
            console.log(`[SUCESSO] Taxa SELIC encontrada: ${selicAnual}. Juros calculados: ${juros}`);
        } else {
            console.warn('[AVISO] A resposta da API da SELIC veio em um formato inesperado. Juros não serão calculados.');
            console.warn('[DEBUG] Resposta recebida:', JSON.stringify(response.data, null, 2));
            juros = 0;
        }

    } catch (error) {
        console.error("[ERRO] Falha ao buscar a taxa SELIC:", error.message);
        juros = 0;
    }
    // ------------------------------------------------------------------

    const valorAtualizado = dar.valor + multa + juros;

    return {
        valorOriginal: dar.valor,
        multa: multa,
        juros: juros,
        diasAtraso: diasAtraso,
        valorAtualizado: valorAtualizado,
        novaDataVencimento: novaDataVencimento.toISOString().split('T')[0]
    };
}

module.exports = { calcularEncargosAtraso };
