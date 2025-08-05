const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

// IMPORTANTE: O ID do seu usuário de teste.
// Como importamos 25 empresas e depois adicionamos o de teste, o ID dele provavelmente é 26.
// Se não funcionar, podemos verificar o ID exato no banco depois.
const idUsuarioTeste = 26; 

// Lista de DARs de exemplo que vamos inserir
const darsDeExemplo = [
    {
        permissionario_id: idUsuarioTeste,
        mes_referencia: 7, // Julho
        ano_referencia: 2025,
        valor: 1550.75,
        data_vencimento: '2025-08-10', // Vencimento futuro
        status: 'Pendente'
    },
    {
        permissionario_id: idUsuarioTeste,
        mes_referencia: 6, // Junho
        ano_referencia: 2025,
        valor: 1550.75,
        data_vencimento: '2025-07-10',
        status: 'Pago' // Um exemplo de DAR já pago
    },
    {
        permissionario_id: idUsuarioTeste,
        mes_referencia: 5, // Maio
        ano_referencia: 2025,
        valor: 1520.00,
        data_vencimento: '2025-06-10', // Vencimento passado
        status: 'Vencido'
    }
];

console.log('Iniciando a inserção de DARs de exemplo...');

const sql = `INSERT INTO dars (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?)`;

db.serialize(() => {
    darsDeExemplo.forEach(dar => {
        db.run(sql, [
            dar.permissionario_id,
            dar.mes_referencia,
            dar.ano_referencia,
            dar.valor,
            dar.data_vencimento,
            dar.status
        ], function(err) {
            if (err) {
                // Se o erro for de 'UNIQUE constraint failed', significa que já inserimos antes.
                if (err.message.includes('UNIQUE')) {
                    console.log(`AVISO: DAR para o mês ${dar.mes_referencia}/${dar.ano_referencia} já existe.`);
                } else {
                    return console.error(`Erro ao inserir DAR para o mês ${dar.mes_referencia}/${dar.ano_referencia}:`, err.message);
                }
            } else {
                console.log(`SUCESSO: DAR para o mês ${dar.mes_referencia}/${dar.ano_referencia} inserido com o ID: ${this.lastID}`);
            }
        });
    });
});

db.close();