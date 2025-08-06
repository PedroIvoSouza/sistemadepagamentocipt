// Em: src/services/sefazService.js
const https = require('https');
const fs = require('fs');
const axios = require('axios');

// --- Variáveis de depuração ---
const CERT_PATH = '/etc/ssl/certs/sefaz_homolog_ca.crt';

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
        // --- Bloco de Depuração do Certificado ---
        console.log('[DEBUG] Verificando o arquivo de certificado...');
        if (fs.existsSync(CERT_PATH)) {
            console.log(`[DEBUG] Arquivo de certificado encontrado em: ${CERT_PATH}`);
        } else {
            // Se o arquivo não existir, o erro será claro.
            console.error(`[ERRO FATAL] O arquivo de certificado não foi encontrado em: ${CERT_PATH}`);
            throw new Error(`Arquivo de certificado não encontrado: ${CERT_PATH}`);
        }
        // -----------------------------------------

        // Cria o agente HTTPS que confia no certificado da SEFAZ
        const httpsAgent = new https.Agent({
            ca: fs.readFileSync(CERT_PATH),
            rejectUnauthorized: false // <--- ADICIONE APENAS ESTA LINHA
        });
        
        console.log('[DEBUG] Agente HTTPS com certificado customizado foi criado.');

        console.log("Enviando para SEFAZ (Homologação):", JSON.stringify(payload, null, 2));

        const response = await axios.post(apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'appToken': appToken
            },
            httpsAgent // Usando o agente customizado
        });
        
        console.log('[SUCESSO] Resposta recebida da SEFAZ.');
        return response.data;
        
    } catch (error) {
        // Log completo do erro para depuração máxima
        console.error("----------------- ERRO DETALHADO -----------------");
        console.error("Mensagem de Erro:", error.message);
        if (error.response) {
            console.error("Status da Resposta:", error.response.status);
            console.error("Dados da Resposta:", JSON.stringify(error.response.data, null, 2));
        }
        console.error("----------------------------------------------------");
        
        throw new Error('Falha na comunicação com a SEFAZ. Verifique os logs de erro para detalhes.');
    }
}

module.exports = { emitirGuiaSefaz };
