// src/services/emailService.js
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

// ---------- Config & Helpers ----------
function readSmtpConfig() {
  // Aceita SMTP_* ou, se ausentes, EMAIL_*
  const host   = process.env.SMTP_HOST   || process.env.EMAIL_HOST;
  const port   = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const user   = process.env.SMTP_USER   || process.env.EMAIL_USER;
  const passRaw= process.env.SMTP_PASS   || process.env.EMAIL_PASS || '';
  // App Password do Gmail costuma vir com espaços na visualização → removemos
  const pass   = String(passRaw).replace(/\s+/g, '');
  const secure = (process.env.SMTP_SECURE === 'true') || port === 465;
  const from   = process.env.SMTP_FROM || process.env.EMAIL_FROM || (user ? `Gestão CIPT <${user}>` : 'Gestão CIPT <no-reply@portalcipt.com.br>');
  const disabled = String(process.env.DISABLE_EMAIL).toLowerCase() === 'true';
  return { host, port, user, pass, secure, from, disabled };
}

function buildTransport() {
  const cfg = readSmtpConfig();

  if (cfg.disabled) {
    console.warn('[MAIL] DISABLE_EMAIL=true → modo DRY-RUN (nenhum e-mail será enviado).');
    return { sendMail: async (opts) => {
      console.log('[MAIL][DRY-RUN]', { to: opts.to, subject: opts.subject });
      return { messageId: 'dry-run' };
    }, from: cfg.from };
  }

  if (!cfg.host || !cfg.user || !cfg.pass) {
    console.warn('[MAIL] SMTP não configurado (host/user/pass ausentes) → modo DRY-RUN.');
    return { sendMail: async (opts) => {
      console.log('[MAIL][DRY-RUN]', { to: opts.to, subject: opts.subject });
      return { messageId: 'dry-run' };
    }, from: cfg.from };
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,           // true = 465 (TLS direto); false = 587 (STARTTLS)
    auth: { user: cfg.user, pass: cfg.pass },
    requireTLS: !cfg.secure,
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });

  // Teste de conexão (não derruba a app)
  transport.verify((err) => {
    if (err) console.warn('[MAIL] verify() falhou:', err.message || err);
    else console.log('[MAIL] SMTP pronto:', `${cfg.host}:${cfg.port}`, cfg.secure ? '(secure)' : '(starttls)');
  });

  // Wrapper para garantir "from" padrão
  return {
    sendMail: (opts) => transport.sendMail({ from: cfg.from, ...opts }),
    from: cfg.from,
  };
}

const mailer = buildTransport();

const BRL = (n) => {
  const num = Number(n || 0);
  // toLocaleString evita dependência de Intl em alguns ambientes Node antigos
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const mesesPT = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function fmtDataISOParaBR(iso) {
  // Emails devem ser legíveis: usamos data em UTC para não ter "dia -1" em alguns clientes
  try {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  } catch { return iso; }
}

// ---------- Funções de Envio ----------
async function enviarEmailNovaDar(emailDestino, dadosDoDar) {
  const competencia = `${mesesPT[dadosDoDar.mes_referencia - 1]} de ${dadosDoDar.ano_referencia}`;
  const dataVenc = fmtDataISOParaBR(dadosDoDar.data_vencimento);
  const valor = BRL(dadosDoDar.valor);
  const linkPortal = `${(process.env.BASE_URL || '').replace(/\/+$/,'')}/dars.html`;

  const html = `
    <div style="font-family: sans-serif; padding: 20px; color: #333;">
      <h1 style="color: #0056a0;">Novo DAR Disponível</h1>
      <p>Olá, <strong>${dadosDoDar.nome_empresa}</strong>,</p>
      <p>O Documento de Arrecadação referente à competência <strong>${competencia}</strong> já está disponível.</p>
      <div style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:16px;margin:16px 0;">
        <p><strong>Vencimento:</strong> ${dataVenc}</p>
        <p><strong>Valor:</strong> R$ ${valor}</p>
      </div>
      <p>Acesse o Portal do Permissionário:</p>
      <p><a href="${linkPortal}" style="background:#0056a0;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Acessar o Portal</a></p>
      <p style="margin-top:24px;font-size:12px;color:#6c757d;">Mensagem automática — não responda.</p>
    </div>
  `;

  try {
    await mailer.sendMail({ to: emailDestino, subject: `DAR Disponível: Competência ${competencia}`, html });
    console.log(`[MAIL] NOVO DAR → ${emailDestino}`);
    return true;
  } catch (e) {
    console.error(`[MAIL][ERRO] NOVO DAR → ${emailDestino}:`, e.message || e);
    return false;
  }
}

async function enviarEmailRedefinicao(emailDestino, codigo) {
  const html = `
    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h1 style="color: #0056a0;">Seu Código de Verificação</h1>
      <p>Use o código abaixo para redefinir sua senha (válido por 10 minutos).</p>
      <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin:20px auto;max-width:220px;">
        <p style="font-size:2.4rem;font-weight:700;letter-spacing:5px;margin:0;color:#343a40;">${codigo}</p>
      </div>
      <p>Se você não solicitou, ignore este e-mail.</p>
    </div>
  `;
  try {
    await mailer.sendMail({ to: emailDestino, subject: 'Código de Verificação - Portal do Permissionário', html });
    console.log(`[MAIL] REDEFINIÇÃO → ${emailDestino}`);
    return true;
  } catch (e) {
    console.error(`[MAIL][ERRO] REDEFINIÇÃO → ${emailDestino}:`, e.message || e);
    return false;
  }
}

async function enviarEmailPrimeiroAcesso(emailDestino, token) {
  const base = (process.env.ADMIN_BASE_URL || '').replace(/\/+$/,'');
  const link = `${base}/admin/definir-senha.html?token=${encodeURIComponent(token)}`;

  const html = `
    <h1>Olá!</h1>
    <p>Crie sua senha de acesso ao portal de gestão do Centro de Inovação.</p>
    <p>O link expira em 1 hora.</p>
    <p><a href="${link}" style="background:#007bff;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Criar Minha Senha</a></p>
    <p>Se você não solicitou, ignore este e-mail.</p>
    <p>Equipe do Centro de Inovação do Jaraguá</p>
  `;

  try {
    await mailer.sendMail({ to: emailDestino, subject: 'Crie sua Senha de Acesso - Sistema de Gestão CIPT', html });
    console.log(`[MAIL] PRIMEIRO ACESSO → ${emailDestino}`);
    return true;
  } catch (e) {
    console.error(`[MAIL][ERRO] PRIMEIRO ACESSO → ${emailDestino}:`, e.message || e);
    return false;
  }
}

async function enviarEmailAdvertencia(emailDestino, dados = {}) {
  const base = (process.env.BASE_URL || '').replace(/\/+$/,'');
  const nome = dados.nome || dados.nome_empresa || dados.cliente_nome || 'Permissionário(a)';

  // Prazo de recurso
  let prazoRecurso = null;
  if (dados.prazo_recurso_data) {
    prazoRecurso = fmtDataISOParaBR(dados.prazo_recurso_data);
  } else if (dados.prazoRecursoData) {
    prazoRecurso = fmtDataISOParaBR(dados.prazoRecursoData);
  } else if (dados.prazo_recurso_dias || dados.prazoRecursoDias) {
    const dias = Number(dados.prazo_recurso_dias || dados.prazoRecursoDias);
    const baseDate = dados.data_advertencia || dados.dataAdvertencia || new Date().toISOString().slice(0,10);
    try {
      const prazoDate = new Date(baseDate + 'T00:00:00Z');
      prazoDate.setUTCDate(prazoDate.getUTCDate() + dias);
      prazoRecurso = prazoDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    } catch { /* ignore */ }
  }

  const valorMulta = Number(dados.valor_multa || dados.valorMulta || 0);

  // Links ou anexos
  let advertenciaLink = dados.pdf_public_url || dados.pdfPublicUrl || dados.pdfUrl || null;
  let darLink = dados.dar_public_url || dados.darPublicUrl || dados.darUrl || null;

  const attachments = [];

  if (!advertenciaLink && dados.pdfPath) {
    const rel = path.relative(path.join(process.cwd(), 'public'), dados.pdfPath);
    if (!rel.startsWith('..')) advertenciaLink = `${base}/${rel.replace(/\\/g, '/')}`;
    if (fs.existsSync(dados.pdfPath)) {
      attachments.push({ filename: path.basename(dados.pdfPath), path: dados.pdfPath });
    }
  }

  if (!darLink && dados.darPath) {
    const relDar = path.relative(path.join(process.cwd(), 'public'), dados.darPath);
    if (!relDar.startsWith('..')) darLink = `${base}/${relDar.replace(/\\/g, '/')}`;
    if (fs.existsSync(dados.darPath)) {
      attachments.push({ filename: path.basename(dados.darPath), path: dados.darPath });
    }
  }

  const html = `
    <div style="font-family: sans-serif; padding: 20px; color: #333;">
      <h1 style="color:#0056a0;">Termo de Advertência</h1>
      <p>Olá, <strong>${nome}</strong>,</p>
      <p>Foi emitido um termo de advertência referente às atividades realizadas no Centro de Inovação.</p>
      ${valorMulta > 0 ? `<p><strong>Valor da multa:</strong> R$ ${BRL(valorMulta)}</p>` : '<p>Não há multa associada a esta advertência.</p>'}
      ${prazoRecurso ? `<p><strong>Prazo para recurso:</strong> até ${prazoRecurso}.</p>` : ''}
      <p><em>Observação:</em> aplica-se a regra padrão de pagamento de 50% do valor devido, salvo orientação em contrário.</p>
      ${advertenciaLink ? `<p>O termo de advertência está disponível <a href="${advertenciaLink}">neste link</a>.</p>` : ''}
      ${darLink ? `<p>O Documento de Arrecadação (DAR), quando aplicável, pode ser acessado <a href="${darLink}">aqui</a>.</p>` : ''}
      <p style="margin-top:24px;font-size:12px;color:#6c757d;">Mensagem automática — não responda.</p>
    </div>`;

  try {
    await mailer.sendMail({ to: emailDestino, subject: 'Advertência - Centro de Inovação', html, attachments });
    console.log(`[MAIL] ADVERTENCIA → ${emailDestino}`);
    return true;
  } catch (e) {
    console.error(`[MAIL][ERRO] ADVERTENCIA → ${emailDestino}:`, e.message || e);
    return false;
  }
}

async function enviarEmailNotificacaoDar(emailDestino, dadosDar) {
  const base = (process.env.BASE_URL || '').replace(/\/+$/,'');
  const linkPortal = `${base}/dars.html`;
  const html = `
    <h1>Olá, ${dadosDar.nome_empresa}!</h1>
    <p>Aviso sobre o seu Documento de Arrecadação (DAR) da competência <strong>${dadosDar.competencia}</strong>.</p>
    <hr>
    <p><strong>Valor:</strong> R$ ${BRL(dadosDar.valor)}</p>
    <p><strong>Vencimento:</strong> ${fmtDataISOParaBR(dadosDar.data_vencimento)}</p>
    <hr>
    <p><a href="${linkPortal}" style="background:#007bff;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Acessar Portal e Gerar DAR</a></p>
    <br><p>Equipe do Centro de Inovação do Jaraguá</p>
  `;
  try {
    await mailer.sendMail({ to: emailDestino, subject: `Notificação de DAR: Competência ${dadosDar.competencia}`, html });
    console.log(`[MAIL] NOTIF DAR → ${emailDestino}`);
    return true;
  } catch (e) {
    console.error(`[MAIL][ERRO] NOTIF DAR → ${emailDestino}:`, e.message || e);
    return false;
  }
}

async function enviarEmailDefinirSenha(destinatario, nomeCliente, token) {
  const base = (process.env.EVENTOS_BASE_URL || process.env.BASE_URL || '').replace(/\/+$/,'');
  const linkDefinirSenha = `${base}/definir-senha-evento.html?token=${encodeURIComponent(token)}`;
  const html = `
    <h1>Olá, ${nomeCliente}!</h1>
    <p>Seu cadastro para evento no Centro de Inovação foi realizado.</p>
    <p>Crie sua senha para gerenciar suas DARs e informações:</p>
    <p><a href="${linkDefinirSenha}" style="background:#0056a0;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Criar Minha Senha</a></p>
    <p>Se você não solicitou, ignore este e-mail.</p>
    <p><strong>Equipe do Centro de Inovação do Jaraguá</strong></p>
  `;
  try {
    await mailer.sendMail({ to: destinatario, subject: 'Crie sua Senha de Acesso - Evento no CIPT', html });
    console.log(`[MAIL] DEFINIR SENHA EVENTO → ${destinatario}`);
    return true;
  } catch (e) {
    console.error(`[MAIL][ERRO] DEFINIR SENHA EVENTO → ${destinatario}:`, e.message || e);
    return false;
  }
}

// ---------- Exports ----------
module.exports = {
  enviarEmailNovaDar,
  enviarEmailRedefinicao,
  enviarEmailPrimeiroAcesso,
  enviarEmailAdvertencia,
  enviarEmailNotificacaoDar,
  enviarEmailDefinirSenha,
};
