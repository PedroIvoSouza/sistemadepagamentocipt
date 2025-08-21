const fs = require('fs');
const path = require('path');
const { enviarAlerta } = require('../services/alertService');

const LOG_FILE = process.env.LOG_FILE || path.join('logs', 'app.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  if (level === 'error') {
    console.error(line);
    enviarAlerta('Erro crítico no sistema', line).catch(() => {});
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
  debug: (msg) => write('debug', msg),
};
