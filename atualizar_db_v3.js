const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v3)...');

db.serialize(() => {
    db.run(`ALTER TABLE permissionarios ADD COLUMN responsavel_financeiro TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Erro ao adicionar coluna "responsavel_financeiro":', err.message);
        } else {
            console.log('Coluna "responsavel_financeiro" verificada/adicionada com sucesso.');
        }
    });

    db.run(`ALTER TABLE permissionarios ADD COLUMN website TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Erro ao adicionar coluna "website":', err.message);
        } else {
            console.log('Coluna "website" verificada/adicionada com sucesso.');
        }
    });
});

db.close(() => {
    console.log('Processo de atualização (v3) finalizado.');
});