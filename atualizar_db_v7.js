// scripts/atualizar_db_v7.js
// Uso: node scripts/atualizar_db_v7.js [novo-arquivo-sqlite]
// Ex.: node scripts/atualizar_db_v7.js cipt-db-v7.sqlite

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function log(s){ console.log(`[atualizar_db_v7] ${s}`); }

const root = path.resolve(__dirname, '..');

// Detecta o arquivo atual do SQLite a partir das variáveis do .env
const ENV_DB = process.env.SQLITE_STORAGE || process.env.DB_STORAGE || process.env.DATABASE_STORAGE;
const defaultDbPath = ENV_DB
  ? (path.isAbsolute(ENV_DB) ? ENV_DB : path.join(root, ENV_DB))
  : path.join(root, 'sistemacipt.db'); // ajuste se seu storage padrão tiver outro nome

const newDbName = process.argv[2] || `cipt-db-v7.sqlite`;
const newDbPath = path.isAbsolute(newDbName) ? newDbName : path.join(root, newDbName);

log(`Base atual: ${defaultDbPath}`);
log(`Nova base : ${newDbPath}`);

// 1) Copia a base atual
fs.copyFileSync(defaultDbPath, newDbPath);
log('Cópia concluída.');

// 2) Roda MIGRATIONS na NOVA base, sem tocar na antiga
const isWin = process.platform === 'win32';
const sqliteUrl = `sqlite:${isWin ? '/' : '////'}${newDbPath}`;

log(`Rodando migrations em ${sqliteUrl} ...`);
execSync(`npx sequelize-cli db:migrate --migrations-path src/migrations --url "${sqliteUrl}"`, {
  stdio: 'inherit',
  cwd: root,
});

log('Migrations concluídas com sucesso.');
log('Agora, aponte o .env para a NOVA base e reinicie o PM2.');

