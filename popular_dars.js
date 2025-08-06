// arquivo: popular_dars.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

const idUsuarioTeste = 26; 

const darsDeExemplo = [
    {
        permissionario_id: idUsuarioTeste,
        mes_referencia: 7, // Julho
        ano_referencia: 2025,
        valor: 1550.75,
        // --- DATA CORRIGIDA AQUI ---
        data_vencimento: '2025-08-08', // Era 10/08 (Domingo), agora 08/08 (Sexta-feira)
        status: 'Pendente'
    },
    {
        permissionario_id: idUsuarioTeste,
        mes_referencia: 6, // Junho
        ano_referencia: 2025,
        valor: 1550.75,
        data_vencimento: '2025-07-10', // Quinta-feira (OK)
        status: 'Pago'
    },
    {
        permissionario_id: idUsuarioTeste,
        mes_referencia: 5, // Maio
        ano_referencia: 2025,
        valor: 1520.00,
        data_vencimento: '2025-06-10', // Terça-feira (OK)
        status: 'Vencido'
    }
];

console.log('Iniciando a inserção de DARs de exemplo com datas corrigidas...');

const sql = `INSERT INTO dars (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?)`;

db.serialize(() => {
    darsDeExemplo.forEach(dar => {
        db.run(sql, [
            dar.permissionario_id, dar.mes_referencia, dar.ano_referencia, dar.valor, dar.data_vencimento, dar.status
        ], function(err) {
            if (err) {
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