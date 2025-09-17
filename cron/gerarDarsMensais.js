// cron/gerarDarsMensais.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { enviarEmailNovaDar } = require('../src/services/emailService');

// ================== Config ==================
const DB_PATH = process.env.SQLITE_STORAGE
  ? path.resolve(__dirname, '..', process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

// Se quiser testar com apenas 1 permissionário, defina TEST_PERMISSIONARIO_ID no .env (ex.: 26)
const TEST_PERMISSIONARIO_ID = process.env.TEST_PERMISSIONARIO_ID
  ? Number(process.env.TEST_PERMISSIONARIO_ID)
  : null;

// ================== Datas (AL, BR) ==================
const { getLastBusinessDay } = require('../src/utils/businessDays');

// ================== Helpers DB ==================
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

// ================== Lógica principal ==================
async function gerarDarsEEnviarNotificacoes() {
  console.log('[ROBÔ] Agendador mensal iniciado.');

  const db = new sqlite3.Database(DB_PATH);
  try {
    const agora = new Date();
    const mesReferencia = agora.getMonth() + 1;
    const anoReferencia = agora.getFullYear();
    const venc = getLastBusinessDay(anoReferencia, mesReferencia);
    const vencISO = new Date(venc.getTime() - venc.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);

    // Busca permissionários (filtrando Isentos ou valor_aluguel zerado)
    let sql = `SELECT * FROM permissionarios WHERE (tipo IS NULL OR tipo != 'Isento') AND COALESCE(valor_aluguel,0) > 0`;
    const params = [];
    if (Number.isInteger(TEST_PERMISSIONARIO_ID)) {
      sql += ` AND id = ?`;
      params.push(TEST_PERMISSIONARIO_ID);
    }

    const permissionarios = await dbAll(db, sql, params); // SEMPRE array
    console.log(
      `[ROBÔ] ${new Date().toLocaleString('pt-BR')}: Iniciando rotina de geração de DARs...`
    );
    console.log(
      `[ROBÔ] ${permissionarios.length} permissionários. Competência ${String(mesReferencia).padStart(2, '0')}/${anoReferencia} - vencimento ${vencISO}`
    );

    if (permissionarios.length === 0) {
      console.warn('[ROBÔ] Nenhum permissionário para processar (provável filtro de teste ativo).');
      return;
    }

    for (const user of permissionarios) {
      try {
        // Verifica se já existe DAR para a competência
        const jaExiste = await dbGet(
          db,
          `SELECT id FROM dars 
             WHERE permissionario_id = ? AND mes_referencia = ? AND ano_referencia = ?`,
          [user.id, mesReferencia, anoReferencia]
        );
        if (jaExiste) {
          // opcional: você pode reenviar notificação se quiser
          continue;
        }

        // Cria DAR
        const valor = Number(user.valor_aluguel || 0);
        await dbRun(
          db,
          `INSERT INTO dars
             (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status)
           VALUES (?, ?, ?, ?, ?, 'Pendente')`,
          [user.id, mesReferencia, anoReferencia, valor, vencISO]
        );

        // Busca o DAR recém-criado para montar o e-mail
        const darCriado = await dbGet(
          db,
          `SELECT * FROM dars
             WHERE permissionario_id = ? AND mes_referencia = ? AND ano_referencia = ?
             ORDER BY id DESC LIMIT 1`,
          [user.id, mesReferencia, anoReferencia]
        );

        // Monta dados do e-mail
        const dadosEmail = {
          nome_empresa: user.nome_empresa,
          mes_referencia: mesReferencia,
          ano_referencia: anoReferencia,
          valor: valor,
          data_vencimento: vencISO,
        };

        // Escolha do destinatário (notificação -> financeiro -> cadastro)
        const destino =
          (user.email_notificacao && String(user.email_notificacao).trim()) ||
          (user.email_financeiro && String(user.email_financeiro).trim()) ||
          (user.email && String(user.email).trim()) ||
          null;

        if (destino) {
          await enviarEmailNovaDar(destino, { ...dadosEmail, nome_empresa: user.nome_empresa });
          console.log(`[ROBÔ] Email enviado para ${destino} (perm #${user.id}).`);
        } else {
          console.warn(
            `[ROBÔ] Permissionário #${user.id} sem e-mail (notificacao/financeiro/cadastro).`
          );
        }
      } catch (itemErr) {
        console.error(`[ROBÔ] Erro ao processar permissionário #${user?.id}:`, itemErr.message || itemErr);
      }
    }
  } catch (error) {
    console.error('[ROBÔ] ERRO CRÍTICO DURANTE A EXECUÇÃO:', error);
  } finally {
    db.close();
    console.log('[ROBÔ] Rotina finalizada.');
  }
}

// Agenda para 08:00 do dia 1 de cada mês (America/Maceio)
cron.schedule('0 8 1 * *', gerarDarsEEnviarNotificacoes, {
  scheduled: true,
  timezone: 'America/Maceio',
});

// Para testar manualmente (roda 1x ao executar o arquivo)
// gerarDarsEEnviarNotificacoes().catch(() => {});
