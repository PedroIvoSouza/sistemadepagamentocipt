const sqlite3 = require('sqlite3').verbose();
const { execSync } = require('child_process');
const path = require('path');

const DB_PATH = process.env.SQLITE_STORAGE || './sistemacipt.db';
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    console.log('Iniciando a verificação/criação das tabelas...');

    // Tabela 1: Permissionários (A que estava faltando)
    db.run(`
        CREATE TABLE IF NOT EXISTS permissionarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_empresa TEXT NOT NULL,
            cnpj TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            numero_sala TEXT NOT NULL,
            valor_aluguel REAL NOT NULL,
            senha TEXT,
            senha_reset_token TEXT,
            senha_reset_expires INTEGER,
            telefone TEXT,
            telefone_cobranca TEXT,
            email_financeiro TEXT,
            responsavel_financeiro TEXT,
            website TEXT,
            email_notificacao TEXT
        );
    `, (err) => {
        if (err) {
            return console.error('Erro ao criar a tabela "permissionarios":', err.message);
        }
        console.log('Tabela "permissionarios" verificada/criada com sucesso.');
    });

    // Tabela 2: Certidoes de Quitacao
    db.run(`
        CREATE TABLE IF NOT EXISTS certidoes_quitacao (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            permissionario_id INTEGER NOT NULL,
            token TEXT NOT NULL,
            file_path TEXT NOT NULL,
            data_emissao TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (permissionario_id) REFERENCES permissionarios (id)
        );
    `, (err) => {
        if (err) {
            return console.error('Erro ao criar a tabela "certidoes_quitacao":', err.message);
        }
        console.log('Tabela "certidoes_quitacao" verificada/criada com sucesso.');
    });

});


db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Conexão com o banco de dados fechada.');

    try {
        console.log('Executando migrações do Sequelize...');
        const absolutePath = path.resolve(DB_PATH);
        execSync(`npx sequelize-cli db:migrate --migrations-path src/migrations --url sqlite:${absolutePath}`, {
            stdio: 'inherit',
        });
        console.log('Migrações executadas com sucesso.');
    } catch (error) {
        console.error('Erro ao executar migrações:', error.message);
    }
});
