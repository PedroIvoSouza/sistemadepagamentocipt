// Em: src/services/sefazService.js

// 1. Importa os módulos 'https' e 'fs' necessários
const https = require('https');
const fs = require('fs');
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

    try {
        // 2. Cria um agente HTTPS que confia no certificado da SEFAZ
        const httpsAgent = new https.Agent({
            ca: fs.readFileSync('/etc/ssl/certs/sefaz_homolog_ca.crt'),
        });

        console.log("Enviando para SEFAZ (Homologação):", JSON.stringify(payload, null, 2));

        // 3. Modifica a chamada do axios para usar o agente HTTPS
        const response = await axios.post(apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'appToken': appToken
            },
            httpsAgent // <--- A MÁGICA ACONTECE AQUI
        });
        
        return response.data; // Retorna a resposta real da SEFAZ
        
    } catch (error) {
        // Log aprimorado para ver o erro de certificado, se houver
        console.error("Erro ao comunicar com a API da SEFAZ:", error.message);
        if (error.response) {
            console.error("Detalhes do erro da SEFAZ:", error.response.data);
        }
        
        const sefazError = error.response?.data?.message || 'Falha na comunicação com a SEFAZ.';
        throw new Error(sefazError);
    }
}

module.exports = { emitirGuiaSefaz };
