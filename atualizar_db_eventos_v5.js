const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sistemacipt.db');

console.log('Iniciando atualização do banco de dados (v5 - Adicionando numero_processo e numero_termo em Eventos)...');

const colunasParaAdicionar = [
  { nome: 'numero_processo', tipo: 'TEXT' },
  { nome: 'numero_termo', tipo: 'TEXT' }
];

db.serialize(() => {
  colunasParaAdicionar.forEach(coluna => {
    db.run(`ALTER TABLE Eventos ADD COLUMN ${coluna.nome} ${coluna.tipo}`, (err) => {
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
    console.log('Processo de atualização (v5) finalizado.');
  });
});
