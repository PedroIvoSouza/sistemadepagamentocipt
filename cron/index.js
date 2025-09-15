// cron/index.js
// Carrega e inicia os agendadores disponíveis
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

require('./gerarDarsMensais');

const comprovanteCronEnabled = (process.env.COMPROVANTE_CRON_ENABLED || '').toLowerCase() === 'true';

if (comprovanteCronEnabled) {
  require('./gerarComprovantesPagos');
} else {
  console.log(
    "[CRON][INDEX] Cron 'gerarComprovantesPagos' desativado via COMPROVANTE_CRON_ENABLED."
  );
}
