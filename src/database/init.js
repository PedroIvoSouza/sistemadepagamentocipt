const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

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

    // Tabela 2: DARs (Versão correta com a trava de segurança)
    db.run(`
        CREATE TABLE IF NOT EXISTS dars (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            permissionario_id INTEGER NOT NULL,
            mes_referencia INTEGER NOT NULL,
            ano_referencia INTEGER NOT NULL,
            valor REAL NOT NULL,
            data_vencimento TEXT NOT NULL,
            status TEXT NOT NULL,
            data_emissao TEXT DEFAULT CURRENT_TIMESTAMP,
            codigo_barras TEXT,
            link_pdf TEXT,
            FOREIGN KEY (permissionario_id) REFERENCES permissionarios (id),
            UNIQUE (permissionario_id, mes_referencia, ano_referencia)
        );
    `, (err) => {
        if (err) {
            return console.error('Erro ao criar a tabela "dars":', err.message);
        }
        console.log('Tabela "dars" verificada/criada com sucesso.');
    });

    // Tabela 3: Certidões de Quitação
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

    // Tabela 4: Salas de Reunião
    db.run(`
        CREATE TABLE IF NOT EXISTS salas_reuniao (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero TEXT NOT NULL,
            capacidade INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'disponivel'
        );
    `, (err) => {
        if (err) {
            return console.error('Erro ao criar a tabela "salas_reuniao":', err.message);
        }
        console.log('Tabela "salas_reuniao" verificada/criada com sucesso.');
    });

    // Tabela 5: Reservas de Salas
    db.run(`
        CREATE TABLE IF NOT EXISTS reservas_salas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sala_id INTEGER NOT NULL,
            permissionario_id INTEGER NOT NULL,
            data TEXT NOT NULL,
            hora_inicio TEXT NOT NULL,
            hora_fim TEXT NOT NULL,
            participantes INTEGER,
            status TEXT,
            checkin TEXT,
            FOREIGN KEY (sala_id) REFERENCES salas_reuniao (id),
            FOREIGN KEY (permissionario_id) REFERENCES permissionarios (id)
        );
    `, (err) => {
        if (err) {
            return console.error('Erro ao criar a tabela "reservas_salas":', err.message);
        }
        console.log('Tabela "reservas_salas" verificada/criada com sucesso.');
    });
});

db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Conexão com o banco de dados fechada.');
});