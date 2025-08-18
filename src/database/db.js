const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

db.configure('busyTimeout', 5000);
db.exec('PRAGMA journal_mode = WAL;');

module.exports = db;
