// testar_notificacao.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();

const { enviarEmailNotificacaoDar, enviarEmailNovaDar } = require('./src/services/emailService');
const { escolherEmailDestino } = require('./src/utils/emailDestino');

const DB_PATH = process.env.SQLITE_STORAGE || './sistemacipt.db';
const db = new sqlite3.Database(DB_PATH);

console.log('--- Iniciando Teste de Notificação de Novo DAR ---');
console.log('DB:', DB_PATH);

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

(async () => {
  try {
    // Pega um permissionário qualquer (ou ajuste o WHERE para um ID específico)
    const perm = await dbGet(`SELECT * FROM permissionarios ORDER BY id LIMIT 1`);
    if (!perm) {
      throw new Error('Nenhum permissionário encontrado no banco.');
    }

    // Escolhe o e-mail com fallback (notificacao -> financeiro -> cadastro)
    let destinatario = escolherEmailDestino(perm);
    if (!destinatario) {
      // Último recurso: manda pra conta de envio (só para teste)
      destinatario = process.env.EMAIL_USER;
      console.warn('⚠️ Nenhum e-mail no cadastro do permissionário. Usando EMAIL_USER do .env para teste:', destinatario);
    }

    // Monta um DAR fictício
    const hoje = new Date();
    const dataISO = new Date(hoje.getTime() - hoje.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

    const dadosDar = {
      nome_empresa: perm.nome_empresa || 'Empresa',
      competencia: 'Teste Automático',
      valor: 123.45,
      data_vencimento: dataISO,
      mes_referencia: hoje.getMonth() + 1,
      ano_referencia: hoje.getFullYear(),
    };

    // Envie um dos dois para testar:
    await enviarEmailNotificacaoDar(destinatario, dadosDar);
    // await enviarEmailNovaDar(destinatario, dadosDar);

    console.log('[OK] E-mail enviado para:', destinatario);
    process.exit(0);
  } catch (err) {
    console.error('ERRO ao testar notificação:', err.message || err);
    process.exit(1);
  } finally {
    db.close();
  }
})();