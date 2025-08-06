const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('--- Verificando o conteúdo da tabela "dars" ---');

const sql = `SELECT id, permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status FROM dars`;

db.all(sql, [], (err, rows) => {
    if (err) {
        return console.error('Erro ao buscar os DARs:', err.message);
    }

    if (rows.length === 0) {
        console.log('A tabela "dars" está vazia.');
    } else {
        // console.table exibe os dados em um formato de tabela bonita
        console.table(rows);
    }
    
    db.close();
});