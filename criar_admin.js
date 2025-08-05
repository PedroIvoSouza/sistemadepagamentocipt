const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

// --- CONFIGURAÇÕES DO PRIMEIRO ADMIN ---
const NOME_ADMIN = 'Administrador Secti';
const EMAIL_ADMIN = 'supcti@secti.al.gov.br'; // Use um e-mail válido seu
const SENHA_ADMIN = 'Supcti@2025#'; // Defina uma senha forte
// -----------------------------------------

const db = new sqlite3.Database('./sistemacipt.db');

async function setupAdmin() {
    console.log('--- Iniciando configuração do usuário administrador ---');
    
    // Passo 1: Cria a tabela de administradores se ela não existir
    const createTableSql = `
        CREATE TABLE IF NOT EXISTS administradores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            senha TEXT NOT NULL
        );
    `;

    await new Promise((resolve, reject) => {
        db.run(createTableSql, (err) => {
            if (err) {
                console.error('ERRO ao criar a tabela de administradores:', err.message);
                reject(err);
            } else {
                console.log('Tabela "administradores" verificada/criada com sucesso.');
                resolve();
            }
        });
    });

    // Passo 2: Criptografa a senha definida
    console.log('Criptografando senha do administrador...');
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(SENHA_ADMIN, saltRounds);
    console.log('Senha criptografada com sucesso.');

    // Passo 3: Insere o primeiro usuário admin na tabela
    // Usamos INSERT OR IGNORE para que, se o e-mail já existir, ele não faça nada e não dê erro.
    const insertSql = `INSERT OR IGNORE INTO administradores (nome, email, senha) VALUES (?, ?, ?)`;
    
    const result = await new Promise((resolve, reject) => {
        db.run(insertSql, [NOME_ADMIN, EMAIL_ADMIN, hashedPassword], function (err) {
            if (err) {
                console.error('ERRO ao inserir o usuário administrador:', err.message);
                reject(err);
            } else {
                resolve(this);
            }
        });
    });

    if (result.changes > 0) {
        console.log(`SUCESSO: Usuário administrador "${NOME_ADMIN}" criado com o ID: ${result.lastID}`);
    } else {
        console.log(`AVISO: Usuário administrador com e-mail "${EMAIL_ADMIN}" já existe.`);
    }

    db.close();
    console.log('--- Configuração do administrador finalizada ---');
}

setupAdmin().catch(err => {
    console.error("Ocorreu um erro geral no script de criação do admin:", err);
});