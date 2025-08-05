const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

// POR FAVOR, SUBSTITUA 'seu-email-principal@dominio.com' PELO SEU EMAIL DE LOGIN
const superAdminEmail = 'supcti@secti.al.gov.br'; 

console.log('Iniciando atualização do banco de dados (v5 - Admin Roles)...');

db.serialize(() => {
    // 1. Adicionar a coluna 'role' na tabela de administradores, se não existir.
    db.run(`ALTER TABLE administradores ADD COLUMN role TEXT NOT NULL DEFAULT 'FINANCE_ADMIN'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            return console.error('Erro ao adicionar coluna "role":', err.message);
        }
        console.log('Coluna "role" verificada/adicionada com sucesso.');
    });

    // 2. Promover o usuário principal a SUPER_ADMIN
    const sql = `UPDATE administradores SET role = 'SUPER_ADMIN' WHERE email = ?`;
    db.run(sql, [superAdminEmail], function(err) {
        if (err) {
            return console.error('Erro ao promover o super admin:', err.message);
        }
        if (this.changes === 0) {
            console.log(`AVISO: Nenhum usuário encontrado com o email ${superAdminEmail}. A promoção para SUPER_ADMIN falhou.`);
        } else {
            console.log(`Sucesso! O usuário ${superAdminEmail} foi promovido a SUPER_ADMIN.`);
        }
    });

    // CORREÇÃO: Fechando o banco de dados AQUI, no final do bloco serialize.
    db.close((err) => {
        if (err) {
            console.error('Erro ao fechar o banco de dados:', err.message);
        }
        console.log('Processo de atualização (v5) finalizado.');
    });
});