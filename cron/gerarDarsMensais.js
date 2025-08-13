// Em: cron/gerarDarsMensais.js
const path = require('path');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { enviarEmailNovaDar } = require('../src/services/emailService');

// ===== Datas úteis / feriados =====
function isFeriado(data) {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dataStr = `${dia}/${mes}`;
  const feriadosFixos = [
    '01/01', // Confraternização Universal
    '21/04', // Tiradentes
    '01/05', // Dia do Trabalho
    '24/06', // São João (AL)
    '07/09', // Independência do Brasil
    '16/09', // Emancipação Política de Alagoas
    '12/10', // Nossa Senhora Aparecida
    '02/11', // Finados
    '15/11', // Proclamação da República
    '25/12'  // Natal
  ];
  return feriadosFixos.includes(dataStr);
}

function isDiaUtil(data) {
  const dow = data.getDay(); // 0 dom, 6 sáb
  if (dow === 0 || dow === 6) return false;
  if (isFeriado(data)) return false;
  return true;
}

// Último dia útil do mês/ano
function getUltimoDiaUtil(ano, mesNumero1a12) {
  // new Date(ano, mesIndex+1, 0) -> ultimo dia do mes
  let data = new Date(ano, mesNumero1a12, 0);
  while (!isDiaUtil(data)) data.setDate(data.getDate() - 1);
  return data;
}

function toISODateLocal(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// ===== Rotina principal =====
async function gerarDarsEEnviarNotificacoes() {
  console.log(`[ROBÔ] ${new Date().toLocaleString('pt-BR')}: Iniciando rotina de geração de DARs...`);

  const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
  const db = new sqlite3.Database(DB_PATH);

  const dbAll = (sql, params=[]) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
  const dbGet = (sql, params=[]) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  const dbRun = (sql, params=[]) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err){ err ? reject(err) : resolve(this); });
  });
    
  try {
    const hoje = new Date();
    const mesReferencia = hoje.getMonth() + 1; // 1..12
    const anoReferencia = hoje.getFullYear();

    const venc = getUltimoDiaUtil(anoReferencia, mesReferencia);
    const vencISO = toISODateLocal(venc);

    const TEST_PERMISSIONARIO_ID = 26;

    const permissionarios = await db.all(`SELECT * FROM permissionarios WHERE id = ?`, [TEST_PERMISSIONARIO_ID]);
    console.log(`[ROBÔ] ${permissionarios.length} permissionários. Competência ${String(mesReferencia).padStart(2,'0')}/${anoReferencia} - vencimento ${vencISO}`);

    for (const p of permissionarios) {
      try {
        // já existe DAR para essa competência?
        const existente = await dbGet(
          `SELECT id FROM dars WHERE permissionario_id = ? AND mes_referencia = ? AND ano_referencia = ?`,
          [p.id, mesReferencia, anoReferencia]
        );
        if (existente) {
          console.log(`[ROBÔ] SKIP p#${p.id} (${p.nome_empresa}): DAR já existe (id=${existente.id}).`);
          continue;
        }

        const valor = Number(p.valor_aluguel || 0);
        if (!(valor > 0)) {
          console.log(`[ROBÔ] SKIP p#${p.id} (${p.nome_empresa}): valor_aluguel inválido (${p.valor_aluguel}).`);
          continue;
        }

        // cria DAR pendente
        const insertRes = await dbRun(
          `INSERT INTO dars (permissionario_id, mes_referencia, ano_referencia, valor, data_vencimento, status)
           VALUES (?, ?, ?, ?, ?, 'Pendente')`,
          [p.id, mesReferencia, anoReferencia, valor, vencISO]
        );
        const novoDarId = insertRes.lastID;

        console.log(`[ROBÔ] DAR criado id=${novoDarId} para p#${p.id} (${p.nome_empresa}). Enviando e-mail...`);

        // fallback de e-mail: email_notificacao -> email_financeiro -> email
        const emailDestino = p.email_notificacao || p.email_financeiro || p.email;
        if (!emailDestino) {
          console.log(`[ROBÔ] ⚠️  p#${p.id} (${p.nome_empresa}) sem e-mail (notificacao/financeiro/principal). Email NÃO enviado.`);
          continue;
        }

        const dadosEmail = {
          nome_empresa: p.nome_empresa,
          mes_referencia: mesReferencia,
          ano_referencia: anoReferencia,
          valor,
          data_vencimento: vencISO
        };

        try {
          await enviarEmailNovaDar(emailDestino, dadosEmail);
          console.log(`[ROBÔ] E-mail enviado para ${emailDestino}.`);
        } catch (errEmail) {
          console.error(`[ROBÔ] Erro ao enviar e-mail para ${emailDestino}:`, errEmail.message);
        }

      } catch (loopErr) {
        console.error(`[ROBÔ] Erro ao processar p#${p.id} (${p.nome_empresa}):`, loopErr.message);
      }
    }
  } catch (error) {
    console.error('[ROBÔ] ERRO CRÍTICO DURANTE A EXECUÇÃO:', error);
  } finally {
    db.close();
    console.log(`[ROBÔ] Rotina finalizada.`);
  }
}

// agenda para todo dia 1 às 08:00 (America/Maceio)
cron.schedule('0 8 1 * *', gerarDarsEEnviarNotificacoes, {
  scheduled: true,
  timezone: 'America/Maceio'
});
console.log('[ROBÔ] Agendador mensal iniciado.');

// Para testar manualmente, descomente:
gerarDarsEEnviarNotificacoes();
