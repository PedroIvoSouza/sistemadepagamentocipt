// Em: atualizar_db_v7.js

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v7 - Adicionando colunas de senha para permissionários)...');

db.serialize(() => {
    // 1. Adiciona a coluna para guardar a senha criptografada
    db.run(`ALTER TABLE permissionarios ADD COLUMN senha_hash TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            return console.error('Erro ao adicionar coluna "senha_hash":', err.message);
        }
        console.log('Coluna "senha_hash" verificada/adicionada com sucesso.');
    });

    // 2. Adiciona a coluna para controlar o primeiro acesso
    db.run(`ALTER TABLE permissionarios ADD COLUMN primeiro_acesso INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            return console.error('Erro ao adicionar coluna "primeiro_acesso":', err.message);
        }
        console.log('Coluna "primeiro_acesso" verificada/adicionada com sucesso.');
    });

    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('Processo de atualização (v7) finalizado.');
    });
});
