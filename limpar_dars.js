// arquivo: limpar_dars.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando processo para limpar a tabela de DARs...');

db.serialize(() => {
    // Este comando apaga TODAS as linhas da tabela 'dars', mas não a tabela em si.
    // As tabelas 'permissionarios' e 'administradores' não são afetadas.
    db.run(`DELETE FROM dars`, function(err) {
        if (err) {
            return console.error('Erro ao limpar a tabela "dars":', err.message);
        }
        console.log(`Tabela "dars" limpa com sucesso. ${this.changes} linhas removidas.`);
    });

    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar o banco:', err.message);
        }
        console.log('Processo de limpeza finalizado.');
    });
});