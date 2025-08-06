const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v6 - Adicionando data_pagamento)...');

db.serialize(() => {
    // Comando SQL para adicionar a nova coluna na tabela 'dars'
    db.run(`ALTER TABLE dars ADD COLUMN data_pagamento DATE`, (err) => {
        // Ignora o erro se a coluna já existir (caso o script seja rodado mais de uma vez)
        if (err && !err.message.includes('duplicate column name')) {
            return console.error('Erro ao adicionar coluna "data_pagamento":', err.message);
        }
        console.log('Coluna "data_pagamento" verificada/adicionada com sucesso na tabela "dars".');
    });

    // Fecha a conexão com o banco de dados de forma segura
    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('Processo de atualização (v6) finalizado.');
    });
});