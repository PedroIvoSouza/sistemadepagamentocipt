const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { enviarEmailNovaDar } = require('../src/services/emailService');

// --- Funções Auxiliares para Datas ---

const formatTimestampBR = (date = new Date()) =>
    date.toLocaleString('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'medium',
        hour12: false,
    });

// Função para verificar se um dia é útil (não é Sábado nem Domingo)
function isDiaUtil(data) {
    const diaDaSemana = data.getDay(); // 0 = Domingo, 6 = Sábado
    return diaDaSemana > 0 && diaDaSemana < 6;
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

// --- Lógica Principal do Robô ---

async function gerarDarsEEnviarNotificacoes() {
    console.log(`[ROBÔ] ${formatTimestampBR()}: Iniciando rotina de geração de DARs...`);
    const db = new sqlite3.Database('./sistemacipt.db');

    try {
        const hoje = new Date();
        const mesReferencia = hoje.getMonth() + 1; // getMonth() é 0-11, então +1
        const anoReferencia = hoje.getFullYear();

        // Calcula a data de vencimento para o último dia útil do mês corrente
        const dataVencimento = getUltimoDiaUtil(anoReferencia, mesReferencia);
        const dataVencimentoStr = dataVencimento.toISOString().split('T')[0]; // Formato AAAA-MM-DD

        // 1. Busca permissionários ativos (ignora isentos ou com valor_aluguel zerado)
        const permissionarios = await new Promise((resolve, reject) => {
            db.all(
                `SELECT * FROM permissionarios WHERE (tipo IS NULL OR tipo != 'Isento') AND COALESCE(valor_aluguel,0) > 0`,
                [],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        console.log(`[ROBÔ] Encontrados ${permissionarios.length} permissionários. Gerando DARs para ${mesReferencia}/${anoReferencia}...`);

        // 2. Para cada permissionário, cria o DAR e envia a notificação
        for (const user of permissionarios) {
            const novoDar = {
                permissionario_id: user.id,
                mes_referencia: mesReferencia,
                ano_referencia: anoReferencia,
                valor: user.valor_aluguel,
                data_vencimento: dataVencimentoStr,
                status: 'Pendente'
            };

            // Insere o novo DAR no banco
            const sqlInsert = `INSERT INTO dars (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?)`;
            const params = [novoDar.permissionario_id, novoDar.mes_referencia, novoDar.ano_referencia, novoDar.valor, novoDar.data_vencimento, novoDar.status];

            const result = await new Promise((resolve, reject) => {
                db.run(sqlInsert, params, function (err) {
                    if (err) reject(err);
                    resolve(this);
                });
            });

            console.log(`[ROBÔ] DAR criado para ${user.nome_empresa} (ID: ${result.lastID}).`);

            // Dispara o e-mail de notificação se o usuário tiver um e-mail cadastrado
            if (user.email_notificacao) {
                const dadosParaEmail = { ...novoDar, nome_empresa: user.nome_empresa };
                await enviarEmailNovaDar(user.email_notificacao, dadosParaEmail);
            } else {
                console.log(`[ROBÔ] AVISO: ${user.nome_empresa} não tem e-mail de notificação cadastrado. E-mail não enviado.`);
            }
        }

    } catch (error) {
        console.error('[ROBÔ] ERRO CRÍTICO DURANTE A EXECUÇÃO:', error);
    } finally {
        db.close();
        console.log(`[ROBÔ] Rotina finalizada.`);
    }
}

// --- Agendamento da Tarefa (Cron Job) ---
// '0 8 1 * *' significa: "Às 08:00 do dia 1 de todo mês."
// O robô vai rodar todo dia 1º, às 8 da manhã.
// A lógica para verificar se é dia útil está dentro da função, mas podemos refinar isso no futuro.
cron.schedule('0 8 1 * *', gerarDarsEEnviarNotificacoes, {
    scheduled: true,
    timezone: "America/Maceio"
});

console.log('[ROBÔ] Agendador de tarefas mensais iniciado. Próxima execução programada para o primeiro dia do mês, às 08:00.');

// Para testes, você pode rodar a função manualmente uma vez.
// gerarDarsEEnviarNotificacoes();