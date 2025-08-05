const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { enviarEmailNovaDar } = require('../src/services/emailService');

function isDiaUtil(data) {
    const diaDaSemana = data.getDay();
    return diaDaSemana > 0 && diaDaSemana < 6;
}

function getUltimoDiaUtil(ano, mes) {
    let data = new Date(ano, mes, 0); 
    while (!isDiaUtil(data)) {
        data.setDate(data.getDate() - 1);
    }
    return data;
}

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

        console.log(`[ROBÔ] Encontrados ${permissionarios.length} permissionários. Gerando DARs para ${mesReferencia}/${anoReferencia}...`);

        for (const user of permissionarios) {
            const novoDar = {
                permissionario_id: user.id,
                mes_referencia: mesReferencia,
                ano_referencia: anoReferencia,
                valor: user.valor_aluguel,
                data_vencimento: dataVencimentoStr,
                status: 'Pendente'
            };

            const result = await new Promise((resolve, reject) => {
                const sqlInsert = `INSERT INTO dars (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?)`;
                const params = [novoDar.permissionario_id, novoDar.mes_referencia, novoDar.ano_referencia, novoDar.valor, novoDar.data_vencimento, novoDar.status];
                db.run(sqlInsert, params, function (err) {
                    if (err) reject(err);
                    resolve(this);
                });
            });

            console.log(`[ROBÔ] DAR criado para ${user.nome_empresa} (ID: ${result.lastID}).`);

            // --- NOVA LÓGICA DE DECISÃO DE E-MAIL ---
            let emailAlvo = null;
            if (user.email_notificacao) {
                emailAlvo = user.email_notificacao;
                console.log(`[ROBÔ] Usando e-mail de notificação: ${emailAlvo}`);
            } else if (user.email_financeiro) {
                emailAlvo = user.email_financeiro;
                console.log(`[ROBÔ] Usando e-mail financeiro: ${emailAlvo}`);
            } else {
                emailAlvo = user.email; // Fallback para o e-mail principal
                console.log(`[ROBÔ] Usando e-mail principal: ${emailAlvo}`);
            }
            // ------------------------------------------

            if (emailAlvo) {
                const dadosParaEmail = { ...novoDar, nome_empresa: user.nome_empresa };
                await enviarEmailNovaDar(emailAlvo, dadosParaEmail);
            } else {
                console.log(`[ROBÔ] AVISO: ${user.nome_empresa} não tem NENHUM e-mail de contato cadastrado. E-mail não enviado.`);
            }
        }

    } catch (error) {
        console.error('[ROBÔ] ERRO CRÍTICO DURANTE A EXECUÇÃO:', error);
    } finally {
        db.close();
        console.log(`[ROBÔ] Rotina finalizada.`);
    }
}

// Agendamento da tarefa (ex: '0 8 1 * *' para 8h do dia 1 de cada mês)
cron.schedule('0 8 1 * *', gerarDarsEEnviarNotificacoes, {
    scheduled: true,
    timezone: "America/Maceio"
});

console.log('[ROBÔ] Agendador de tarefas mensais iniciado.');