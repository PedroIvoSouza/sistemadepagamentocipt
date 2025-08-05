const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

// --- Dados do Usuário de Teste ---
const nomeEmpresa = 'SECTI Alagoas (TESTE)';
const cnpj = '04.007.216/0001-30';
const email = 'pedroivodesouza@gmail.com';
const numeroSala = 'SALA-TESTE';
const valorAluguel = 10.00; // Valor simbólico

// "INSERT OR IGNORE" é um comando seguro: se o CNPJ ou e-mail já existirem,
// ele simplesmente não faz nada, sem gerar erro.
const sql = `
    INSERT OR IGNORE INTO permissionarios (nome_empresa, cnpj, email, numero_sala, valor_aluguel) 
    VALUES (?, ?, ?, ?, ?)
`;

db.run(sql, [nomeEmpresa, cnpj, email, numeroSala, valorAluguel], function(err) {
    if (err) {
        return console.error('Erro ao inserir usuário de teste:', err.message);
    }

    // this.changes nos diz se alguma linha foi realmente inserida
    if (this.changes > 0) {
        console.log(`SUCESSO: Usuário de teste "${nomeEmpresa}" foi inserido no banco.`);
    } else {
        console.log(`AVISO: Usuário de teste com CNPJ ${cnpj} já existia no banco.`);
    }
});

db.close();