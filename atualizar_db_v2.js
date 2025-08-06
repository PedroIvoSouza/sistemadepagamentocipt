const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v2)...');

db.serialize(() => {
    // Adiciona a coluna 'telefone', se ela não existir
    db.run(`ALTER TABLE permissionarios ADD COLUMN telefone TEXT`, (err) => {
        if (err) {
            // Se o erro for "duplicate column name", significa que já rodamos este script. Ignoramos.
            if (err.message.includes('duplicate column name')) {
                console.log('Coluna "telefone" já existe.');
            } else {
                console.error('Erro ao adicionar coluna "telefone":', err.message);
            }
        } else {
            console.log('Coluna "telefone" adicionada com sucesso.');
        }
    });

    // Adiciona a coluna 'email_financeiro', se ela não existir
    db.run(`ALTER TABLE permissionarios ADD COLUMN email_financeiro TEXT`, (err) => {
        if (err) {
            if (err.message.includes('duplicate column name')) {
                console.log('Coluna "email_financeiro" já existe.');
            } else {
                console.error('Erro ao adicionar coluna "email_financeiro":', err.message);
            }
        } else {
            console.log('Coluna "email_financeiro" adicionada com sucesso.');
        }
    });
});

db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Processo de atualização finalizado.');
});