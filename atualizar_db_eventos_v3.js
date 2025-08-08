// Em: atualizar_db_eventos_v2.js

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v2 - Adicionando CPF do Responsável)...');

db.serialize(() => {
    // Comando SQL para adicionar a nova coluna na tabela 'Clientes_Eventos'
    db.run(`ALTER TABLE Clientes_Eventos ADD COLUMN documento_responsavel TEXT`, (err) => {
        // Ignora o erro se a coluna já existir
        if (err && !err.message.includes('duplicate column name')) {
            return console.error('Erro ao adicionar coluna "documento_responsavel":', err.message);
        }
        console.log('Coluna "documento_responsavel" verificada/adicionada com sucesso.');
    });

    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('Processo de atualização (v2) finalizado.');
    });
});
