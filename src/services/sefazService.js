// Em: src/services/sefazService.js
const axios = require('axios');

async function emitirGuiaSefaz(dadosPermissionario, dadosDar) {
    const apiUrl = `${process.env.SEFAZ_API_URL_HOM}/api/public/guia/emitir`;
    const appToken = process.env.SEFAZ_APP_TOKEN;

    const payload = {
        versao: "1.0",
        contribuinteEmitente: {
            codigoTipoInscricao: 4,
            numeroInscricao: dadosPermissionario.cnpj.replace(/\D/g, ''),
            nome: dadosPermissionario.nome_empresa,
            codigoIbgeMunicipio: 2704302,
        },
        receitas: [
            {
                codigo: 20165,
                competencia: {
                    mes: dadosDar.mes_referencia,
                    ano: dadosDar.ano_referencia
                },
                valorPrincipal: dadosDar.valor,
                dataVencimento: dadosDar.data_vencimento
            }
        ],
        dataLimitePagamento: dadosDar.data_vencimento,
        observacao: `Pagamento referente ao aluguel do permissionário ${dadosPermissionario.nome_empresa}`
    };

    // CÓDIGO REAL ATIVADO
    try {
        console.log("Enviando para SEFAZ (Homologação):", JSON.stringify(payload, null, 2));
        const response = await axios.post(apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'appToken': appToken
            }
        });
        return response.data; // Retorna a resposta real da SEFAZ
    } catch (error) {
        console.error("Erro ao comunicar com a API da SEFAZ:", error.response ? error.response.data : error.message);
        const sefazError = error.response?.data?.message || 'Falha na comunicação com a SEFAZ.';
        throw new Error(sefazError);
    }
}

module.exports = { emitirGuiaSefaz };