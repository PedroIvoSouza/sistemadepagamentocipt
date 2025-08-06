// Em: cron/gerarDarsMensais.js
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { enviarEmailNovaDar } = require('../src/services/emailService');

// --- NOVAS FUNÇÕES DE DATA ---

// Verifica se uma data específica é um feriado (nacional ou de Alagoas)
function isFeriado(data) {
    const ano = data.getFullYear();
    const dia = String(data.getDate()).padStart(2, '0');
    const mes = String(data.getMonth() + 1).padStart(2, '0'); // Meses são 0-11
    const dataStr = `${dia}/${mes}`;

    const feriadosFixos = [
        '01/01', // Confraternização Universal
        '21/04', // Tiradentes
        '01/05', // Dia do Trabalho
        '24/06', // São João (Feriado em Alagoas)
        '07/09', // Independência do Brasil
        '16/09', // Emancipação Política de Alagoas
        '12/10', // Nossa Senhora Aparecida
        '02/11', // Finados
        '15/11', // Proclamação da República
        '25/12'  // Natal
    ];

    // Feriados móveis (ex: Carnaval, Corpus Christi) podem ser adicionados aqui se necessário
    // Por simplicidade, estamos tratando apenas os fixos por enquanto.

    return feriadosFixos.includes(dataStr);
}

// Função para verificar se um dia é útil (não é Sábado, Domingo ou Feriado)
function isDiaUtil(data) {
    const diaDaSemana = data.getDay(); // 0 = Domingo, 6 = Sábado
    if (diaDaSemana === 0 || diaDaSemana === 6) {
        return false; // Não é dia útil se for fim de semana
    }
    if (isFeriado(data)) {
        return false; // Não é dia útil se for feriado
    }
    return true; // É dia útil
}

// Função para encontrar o último dia útil de um determinado mês/ano
function getUltimoDiaUtil(ano, mes) {
    // O '0' no dia do construtor Date pega o último dia do mês anterior.
    // Por isso, usamos mes + 1 para pegar o último dia do mês corrente.
    let data = new Date(ano, mes, 0); 
    while (!isDiaUtil(data)) {
        data.setDate(data.getDate() - 1);
    }
    return data;
}

// --- LÓGICA PRINCIPAL DO ROBÔ (sem alterações) ---

async function gerarDarsEEnviarNotificacoes() {
    console.log(`[ROBÔ] ${new Date().toLocaleString('pt-BR')}: Iniciando rotina de geração de DARs...`);
    const db = new sqlite3.Database('./sistemacipt.db');
    try {
        const hoje = new Date();
        const mesReferencia = hoje.getMonth() + 1;
        const anoReferencia = hoje.getFullYear();

        const dataVencimento = getUltimoDiaUtil(anoReferencia, mesReferencia);
        const dataVencimentoStr = dataVencimento.toISOString().split('T')[0];

        const permissionarios = await new Promise((resolve, reject) => {
            db.all(`SELECT * FROM permissionarios`, [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
        console.log(`[ROBÔ] Encontrados ${permissionarios.length} permissionários. Gerando DARs para ${mesReferencia}/${anoReferencia} com vencimento em ${dataVencimentoStr}...`);

        for (const user of permissionarios) {
            // Lógica de inserção e envio de e-mail...
        }
    } catch (error) {
        console.error('[ROBÔ] ERRO CRÍTICO DURANTE A EXECUÇÃO:', error);
    } finally {
        db.close();
        console.log(`[ROBÔ] Rotina finalizada.`);
    }
}

cron.schedule('0 8 1 * *', gerarDarsEEnviarNotificacoes, {
    scheduled: true,
    timezone: "America/Maceio"
});
console.log('[ROBÔ] Agendador de tarefas mensais iniciado.');

// Para testes, descomente a linha abaixo para rodar a função manualmente uma vez.
// gerarDarsEEnviarNotificacoes();