// Importa o driver do sqlite3
const sqlite3 = require('sqlite3').verbose();
// Abre (ou cria, se não existir) o arquivo do banco de dados
const db = new sqlite3.Database('./sistemacipt.db');

db.serialize(() => {
    // O .serialize garante que os comandos sejam executados em ordem

    console.log('Iniciando a criação da tabela de permissionários...');

    // Comando para criar a tabela
    db.run(`
        CREATE TABLE IF NOT EXISTS permissionarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_empresa TEXT NOT NULL,
            cnpj TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            valor_aluguel REAL NOT NULL,
            senha TEXT NOT NULL 
        );
    `, (err) => {
        if (err) {
            return console.error('Erro ao criar a tabela:', err.message);
        }
        console.log('Tabela "permissionarios" criada ou já existente com sucesso.');
    });
});

// Fecha a conexão com o banco de dados
db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Conexão com o banco de dados fechada.');
});