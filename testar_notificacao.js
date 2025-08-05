const sqlite3 = require('sqlite3').verbose();
const { enviarEmailNovaDar } = require('../src/services/emailService');

const db = new sqlite3.Database('./sistemacipt.db');

// ID do nosso usuário de teste
const idUsuarioTeste = 26;

console.log('--- Iniciando Teste de Notificação de Novo DAR ---');

// 1. Busca os dados do usuário de teste no banco
const sqlBuscaUsuario = `SELECT * FROM permissionarios WHERE id = ?`;

db.get(sqlBuscaUsuario, [idUsuarioTeste], (err, user) => {
    if (err) {
        return console.error('ERRO: Não foi possível buscar o usuário de teste.', err.message);
    }
    if (!user) {
        return console.error('ERRO: Usuário de teste com ID ' + idUsuarioTeste + ' não encontrado.');
    }
    if (!user.email_notificacao) {
        return console.error(`ERRO: O usuário de teste não tem um 'E-mail para DARs' definido no perfil.`);
    }

    console.log(`Usuário de teste "${user.nome_empresa}" encontrado.`);
    console.log(`E-mail de notificação a ser usado: ${user.email_notificacao}`);

    // 2. Prepara os dados do novo DAR a ser criado (Ex: para o mês de Agosto de 2025)
    const novoDar = {
        permissionario_id: user.id,
        mes_referencia: 8,
        ano_referencia: 2025,
        valor: user.valor_aluguel, // Usa o valor base do aluguel do cadastro
        data_vencimento: '2025-08-29', // Último dia útil de Agosto de 2025
        status: 'Pendente'
    };

    // 3. Insere o novo DAR no banco de dados
    const sqlInsertDar = `INSERT INTO dars (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?)`;
    const params = [novoDar.permissionario_id, novoDar.mes_referencia, novoDar.ano_referencia, novoDar.valor, novoDar.data_vencimento, novoDar.status];
    
    db.run(sqlInsertDar, params, async function(err) {
        if (err) {
            return console.error('ERRO: Falha ao inserir o novo DAR de teste no banco.', err.message);
        }

        console.log(`SUCESSO: Novo DAR para ${novoDar.mes_referencia}/${novoDar.ano_referencia} criado com ID ${this.lastID}.`);

        // 4. Se o DAR foi criado com sucesso, dispara o e-mail de notificação
        try {
            const dadosParaEmail = { ...novoDar, nome_empresa: user.nome_empresa };
            await enviarEmailNovaDar(user.email_notificacao, dadosParaEmail);
            console.log('--- Teste Finalizado com Sucesso! ---');
        } catch (emailError) {
            console.error('ERRO: O DAR foi criado, mas falhou ao enviar o e-mail de notificação.', emailError.message);
        } finally {
            db.close();
        }
    });
});