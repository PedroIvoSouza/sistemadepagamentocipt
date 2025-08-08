// Em: atualizar_db_eventos.js

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados para o Módulo de Eventos...');

db.serialize(() => {
    // 1. Tabela para Clientes de Eventos
    const createClientesEventosTable = `
    CREATE TABLE IF NOT EXISTS Clientes_Eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome_razao_social TEXT NOT NULL,
        tipo_pessoa TEXT NOT NULL CHECK(tipo_pessoa IN ('PF', 'PJ')),
        documento TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        telefone TEXT,
        endereco TEXT,
        nome_responsavel TEXT,
        senha_hash TEXT NOT NULL,
        tipo_cliente TEXT NOT NULL DEFAULT 'Geral' CHECK(tipo_cliente IN ('Geral', 'Governo', 'Permissionario'))
    );`;

    db.run(createClientesEventosTable, (err) => {
        if (err) {
            return console.error('Erro ao criar tabela "Clientes_Eventos":', err.message);
        }
        console.log('Tabela "Clientes_Eventos" verificada/criada com sucesso.');
    });

    // 2. Tabela para Eventos
    const createEventosTable = `
    CREATE TABLE IF NOT EXISTS Eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_cliente INTEGER NOT NULL,
        nome_evento TEXT NOT NULL,
        datas_evento TEXT NOT NULL,
        total_diarias INTEGER NOT NULL,
        valor_bruto REAL NOT NULL,
        tipo_desconto_auto TEXT DEFAULT 'Nenhum',
        percentual_desconto_manual REAL DEFAULT 0,
        valor_final REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pendente' CHECK(status IN ('Pendente', 'Pago Parcialmente', 'Pago', 'Cancelado')),
        FOREIGN KEY (id_cliente) REFERENCES Clientes_Eventos (id)
    );`;

    db.run(createEventosTable, (err) => {
        if (err) {
            return console.error('Erro ao criar tabela "Eventos":', err.message);
        }
        console.log('Tabela "Eventos" verificada/criada com sucesso.');
    });

    // 3. Tabela para DARs de Eventos
    const createDarsEventosTable = `
    CREATE TABLE IF NOT EXISTS DARs_Eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_evento INTEGER NOT NULL,
        id_dar INTEGER NOT NULL,
        numero_parcela INTEGER NOT NULL,
        valor_parcela REAL NOT NULL,
        data_vencimento TEXT NOT NULL,
        FOREIGN KEY (id_evento) REFERENCES Eventos (id),
        FOREIGN KEY (id_dar) REFERENCES dars (id)
    );`;

    db.run(createDarsEventosTable, (err) => {
        if (err) {
            return console.error('Erro ao criar tabela "DARs_Eventos":', err.message);
        }
        console.log('Tabela "DARs_Eventos" verificada/criada com sucesso.');
    });

    // Fecha a conexão com o banco de dados de forma segura
    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('Processo de atualização para o Módulo de Eventos finalizado.');
    });
});