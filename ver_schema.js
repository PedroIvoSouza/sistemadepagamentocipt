// Em: ver_schema.js
// Este script lê e exibe a estrutura das suas tabelas no banco de dados.

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Lendo o schema do banco de dados: sistemacipt.db\n');

const tabelas = ['permissionarios', 'dars', 'Clientes_Eventos', 'Eventos', 'DARs_Eventos'];

db.serialize(() => {
    tabelas.forEach(tabela => {
        db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [tabela], (err, row) => {
            if (err) {
                return console.error(`Erro ao buscar o schema da tabela ${tabela}:`, err.message);
            }
            if (row) {
                console.log(`--- Schema da Tabela: ${tabela} ---`);
                console.log(row.sql + ';\n');
            } else {
                console.log(`Tabela "${tabela}" não encontrada.`);
            }
        });
    });

    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
    });
});
