// testar_notificacao.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();

const { enviarEmailNotificacaoDar, enviarEmailNovaDar } = require('./src/services/emailService');
const { escolherEmailDestino } = require('./src/utils/emailDestino');

const DB_PATH = process.env.SQLITE_STORAGE || './sistemacipt.db';
const db = new sqlite3.Database(DB_PATH);

console.log('--- Iniciando Teste de Notificação de Novo DAR ---');
console.log('DB:', DB_PATH);

// Permite forçar um ID específico:
// 1) via .env -> TEST_PERMISSIONARIO_ID=26
// 2) via CLI  -> node testar_notificacao.js --id=26
const cliId = (process.argv.find(a => a.startsWith('--id=')) || '').split('=')[1];
const TEST_PERMISSIONARIO_ID = Number(cliId || process.env.TEST_PERMISSIONARIO_ID || 0) || null;

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

(async () => {
  try {
    // Busca o permissionário-alvo
    let perm;
    if (TEST_PERMISSIONARIO_ID) {
      console.log(`[TESTE] Usando permissionário específico (id=${TEST_PERMISSIONARIO_ID}).`);
      perm = await dbGet(`SELECT * FROM permissionarios WHERE id = ?`, [TEST_PERMISSIONARIO_ID]);
      if (!perm) {
        throw new Error(`Permissionário id=${TEST_PERMISSIONARIO_ID} não encontrado.`);
      }
    } else {
      console.log('[TESTE] Nenhum ID específico informado. Buscando o primeiro permissionário da base.');
      perm = await dbGet(`SELECT * FROM permissionarios ORDER BY id LIMIT 1`);
      if (!perm) throw new Error('Nenhum permissionário encontrado no banco.');
    }

    // Escolhe o e-mail com fallback (notificacao -> financeiro -> cadastro)
    let destinatario = escolherEmailDestino(perm);
    if (!destinatario) {
      // Último recurso: conta do remetente (apenas para teste)
      destinatario = process.env.EMAIL_USER;
      console.warn('⚠️  Permissionário sem e-mail cadastrado. Usando EMAIL_USER do .env para teste:', destinatario);
    }

    // Monta um DAR fictício
    const agora = new Date();
    const dataISO = new Date(agora.getTime() - agora.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);

    const dadosDar = {
      nome_empresa: perm.nome_empresa || 'Empresa',
      competencia: 'Teste Automático',
      valor: 123.45,
      data_vencimento: dataISO,
      mes_referencia: agora.getMonth() + 1,
      ano_referencia: agora.getFullYear(),
    };

    // Dispare UMA das funções abaixo. Por padrão, testamos a notificação “simples”:
    await enviarEmailNotificacaoDar(destinatario, dadosDar);
    // Ou, se quiser testar o modelo de “novo DAR disponível”:
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