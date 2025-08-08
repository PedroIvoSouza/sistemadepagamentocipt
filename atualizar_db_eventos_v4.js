const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v3 - Adicionando campos de endereço estruturado)...');

const colunasParaAdicionar = [
    { nome: 'cep', tipo: 'TEXT' },
    { nome: 'logradouro', tipo: 'TEXT' },
    { nome: 'numero', tipo: 'TEXT' },
    { nome: 'complemento', tipo: 'TEXT' },
    { nome: 'bairro', tipo: 'TEXT' },
    { nome: 'cidade', tipo: 'TEXT' },
    { nome: 'uf', tipo: 'TEXT' }
];

db.serialize(() => {
    colunasParaAdicionar.forEach(coluna => {
        db.run(`ALTER TABLE Clientes_Eventos ADD COLUMN ${coluna.nome} ${coluna.tipo}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                return console.error(`Erro ao adicionar coluna "${coluna.nome}":`, err.message);
            }
            console.log(`Coluna "${coluna.nome}" verificada/adicionada com sucesso.`);
        });
    });

    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('Processo de atualização (v3) finalizado.');
    });
});