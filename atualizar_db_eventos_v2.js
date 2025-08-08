// Em: atualizar_db_eventos_v2.js

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v2 - Fluxo de Senha para Eventos)...');

db.serialize(() => {
    // 1. Modifica a coluna 'senha_hash' para permitir valores nulos
    // Faremos isso recriando a tabela, pois o SQLite tem limitações com ALTER TABLE.
    db.run(`
        CREATE TABLE IF NOT EXISTS Clientes_Eventos_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_razao_social TEXT NOT NULL,
            tipo_pessoa TEXT NOT NULL CHECK(tipo_pessoa IN ('PF', 'PJ')),
            documento TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL,
            telefone TEXT,
            endereco TEXT,
            nome_responsavel TEXT,
            senha_hash TEXT, -- Alterado para permitir NULL
            tipo_cliente TEXT NOT NULL DEFAULT 'Geral' CHECK(tipo_cliente IN ('Geral', 'Governo', 'Permissionario')),
            token_definir_senha TEXT -- Nova coluna para o token
        );
    `, (err) => {
        if (err) return console.error('Erro ao criar tabela temporária:', err.message);
        console.log('Tabela temporária "Clientes_Eventos_new" criada com sucesso.');

        // Copia os dados antigos, se houver
        db.run(`INSERT INTO Clientes_Eventos_new (id, nome_razao_social, tipo_pessoa, documento, email, telefone, endereco, nome_responsavel, senha_hash, tipo_cliente) SELECT id, nome_razao_social, tipo_pessoa, documento, email, telefone, endereco, nome_responsavel, senha_hash, tipo_cliente FROM Clientes_Eventos`, function(err) {
            if (err && !err.message.includes('no such table: Clientes_Eventos')) {
                return console.error('Erro ao copiar dados:', err.message);
            }
            console.log('Dados antigos copiados (se existiam).');

            // Apaga a tabela antiga
            db.run(`DROP TABLE IF EXISTS Clientes_Eventos`, (err) => {
                if (err) return console.error('Erro ao apagar tabela antiga:', err.message);
                console.log('Tabela antiga "Clientes_Eventos" removida.');

                // Renomeia a nova tabela
                db.run(`ALTER TABLE Clientes_Eventos_new RENAME TO Clientes_Eventos`, (err) => {
                    if (err) return console.error('Erro ao renomear tabela:', err.message);
                    console.log('Tabela "Clientes_Eventos" atualizada com sucesso para a nova estrutura.');
                    
                    // Fecha a conexão
                    db.close((err) => {
                        if (err) return console.error('Erro ao fechar o banco:', err.message);
                        console.log('Processo de atualização (v2) finalizado.');
                    });
                });
            });
        });
    });
});