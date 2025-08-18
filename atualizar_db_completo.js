// Em: atualizar_db_completo.js
// Este script executa todas as atualizações de schema necessárias de uma só vez.

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização completa do banco de dados...');

db.serialize(() => {
    console.log('\n--- Verificando tabela "permissionarios" ---');
    
    // Adiciona colunas à tabela 'permissionarios'
    db.run(`ALTER TABLE permissionarios ADD COLUMN senha_hash TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) return console.error(err.message);
        console.log('Coluna "senha_hash" verificada/adicionada.');
    });

    db.run(`ALTER TABLE permissionarios ADD COLUMN primeiro_acesso INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column name')) return console.error(err.message);
        console.log('Coluna "primeiro_acesso" verificada/adicionada.');
    });

    console.log('\n--- Verificando tabela "dars" ---');
    
    // Adiciona coluna à tabela 'dars'
    db.run(`ALTER TABLE dars ADD COLUMN tipo_permissionario TEXT DEFAULT 'Permissionario'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) return console.error(err.message);
        console.log('Coluna "tipo_permissionario" verificada/adicionada.');
    });

    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('\nProcesso de atualização completo.');
    });
});
