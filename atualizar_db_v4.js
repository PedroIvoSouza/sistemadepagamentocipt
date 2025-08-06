const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v4)...');

db.serialize(() => {
    db.run(`ALTER TABLE permissionarios ADD COLUMN email_notificacao TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Erro ao adicionar coluna "email_notificacao":', err.message);
        } else {
            console.log('Coluna "email_notificacao" verificada/adicionada com sucesso.');
        }
    });
});

db.close(() => {
    console.log('Processo de atualização (v4) finalizado.');
});