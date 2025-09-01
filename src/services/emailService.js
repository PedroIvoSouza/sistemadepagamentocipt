// Em: src/services/emailService.js

const nodemailer = require('nodemailer');
// O dotenv é geralmente carregado no index.js principal, mas não há problema em tê-lo aqui.
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  // Porta 465 utiliza TLS; outras portas (ex. 587) usam STARTTLS
  secure: Number(process.env.EMAIL_PORT) === 465,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

/**
 * Envia um e-mail de notificação sobre um novo DAR gerado.
 * (Sua função existente)
 */
async function enviarEmailNovaDar(emailDestino, dadosDoDar) {
    const dataVencimentoFormatada = new Date(dadosDoDar.data_vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    const competencia = `${meses[dadosDoDar.mes_referencia - 1]} de ${dadosDoDar.ano_referencia}`;
    const valorFormatado = dadosDoDar.valor.toFixed(2).replace('.', ',');
    const linkPortal = `${process.env.BASE_URL}/dars.html`; 

    const mailOptions = {
        from: `"Gestão CIPT" <${process.env.EMAIL_USER}>`,
        to: emailDestino,
        subject: `DAR Disponível: Competência ${competencia}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; color: #333;">
                <h1 style="color: #0056a0;">Novo DAR Disponível</h1>
                <p>Olá, ${dadosDoDar.nome_empresa},</p>
                <p>Informamos que o Documento de Arrecadação (DAR) referente à competência de <strong>${competencia}</strong> já está disponível em seu portal.</p>
                <div style="background-color: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 20px; margin: 20px 0;">
                    <h3 style="margin-top: 0;">Detalhes da Cobrança</h3>
                    <p><strong>Vencimento:</strong> ${dataVencimentoFormatada}</p>
                    <p><strong>Valor:</strong> R$ ${valorFormatado}</p>
                </div>
                <p>Para visualizar e emitir o documento, acesse o Portal do Permissionário clicando no botão abaixo.</p>
                <a href="${linkPortal}" style="background-color: #0056a0; color: white; padding: 15px 25px; text-align: center; text-decoration: none; display: inline-block; border-radius: 5px; font-size: 16px;">
                    Acessar o Portal
                </a>
                <p style="margin-top: 30px; font-size: 12px; color: #6c757d;">
                    Esta é uma mensagem automática. Por favor, não responda a este e-mail.
                </p>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email de NOVO DAR enviado para: ${emailDestino}`);
    } catch (error) {
        console.error(`Erro ao enviar e-mail de NOVO DAR para ${emailDestino}:`, error);
        throw new Error('Falha ao enviar o e-mail de notificação.');
    }
}

/**
 * Envia um e-mail com o código de verificação para redefinir a senha.
 * (Sua função existente)
 */
async function enviarEmailRedefinicao(emailDestino, codigo) {
    const mailOptions = {
        from: `"Gestão CIPT" <${process.env.EMAIL_USER}>`,
        to: emailDestino,
        subject: 'Código de Verificação - Portal do Permissionário',
        html: `
            <div style="font-family: sans-serif; text-align: center; padding: 20px;">
                <h1 style="color: #0056a0;">Seu Código de Verificação</h1>
                <p>Use o código abaixo para redefinir sua senha. Este código é válido por 10 minutos.</p>
                <div style="background-color: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px auto; max-width: 200px;">
                    <p style="font-size: 2.5rem; font-weight: 700; letter-spacing: 5px; margin: 0; color: #343a40;">
                        ${codigo}
                    </p>
                </div>
                <p>Se você não solicitou isso, por favor, ignore este e-mail.</p>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email com código de redefinição enviado para: ${emailDestino}`);
    } catch (error) {
        console.error(`Erro ao enviar e-mail para ${emailDestino}:`, error);
        throw new Error('Falha ao enviar o e-mail.');
    }
}

/**
 * Envia um e-mail com link direto para o primeiro acesso do ADMINISTRADOR.
 * (Sua função existente)
 */
async function enviarEmailPrimeiroAcesso(emailDestino, token) {
    const link = `${process.env.ADMIN_BASE_URL}/admin/definir-senha.html?token=${token}`;
    
    const mailOptions = {
        from: `"Gestão CIPT" <${process.env.EMAIL_USER}>`,
        to: emailDestino,
        subject: 'Crie sua Senha de Acesso - Sistema de Gestão CIPT',
        html: `
            <h1>Olá!</h1>
            <p>Você está recebendo este e-mail para criar sua senha de acesso ao portal de gestão do Centro de Inovação.</p>
            <p>Por favor, clique no link abaixo para definir sua senha. Este link é válido por 1 hora.</p>
            <a href="${link}" style="background-color: #007bff; color: white; padding: 15px 25px; text-align: center; text-decoration: none; display: inline-block; border-radius: 5px;">
                Criar Minha Senha
            </a>
            <p>Se você não solicitou isso, por favor, ignore este e-mail.</p>
            <br>
            <p>Atenciosamente,</p>
            <p>Equipe do Centro de Inovação do Jaraguá</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email de configuração de senha enviado para: ${emailDestino}`);
    } catch (error) {
        console.error(`Erro ao enviar e-mail para ${emailDestino}:`, error);
    }
}

/**
 * Envia um e-mail de notificação de DAR a partir do painel do admin.
 * (Sua função existente)
 */
async function enviarEmailNotificacaoDar(emailDestino, dadosDar) {
    const linkPortal = `${process.env.BASE_URL}/dars.html`;

    const mailOptions = {
        from: `"Gestão CIPT" <${process.env.EMAIL_USER}>`,
        to: emailDestino,
        subject: `Notificação de DAR: Competência ${dadosDar.competencia}`,
        html: `
            <h1>Olá, ${dadosDar.nome_empresa}!</h1>
            <p>Este é um aviso sobre o seu Documento de Arrecadação (DAR) referente à competência <strong>${dadosDar.competencia}</strong>.</p>
            <hr>
            <p><strong>Valor:</strong> R$ ${dadosDar.valor.toFixed(2).replace('.', ',')}</p>
            <p><strong>Vencimento:</strong> ${new Date(dadosDar.data_vencimento).toLocaleDateString('pt-BR', {timeZone: 'UTC'})}</p>
            <hr>
            <p>Para gerar seu DAR e efetuar o pagamento, por favor, acesse o Portal do Permissionário clicando no botão abaixo:</p>
            <a href="${linkPortal}" style="background-color: #007bff; color: white; padding: 15px 25px; text-align: center; text-decoration: none; display: inline-block; border-radius: 5px;">
                Acessar Portal e Gerar DAR
            </a>
            <br><br>
            <p>Atenciosamente,</p>
            <p>Equipe do Centro de Inovação do Jaraguá</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email de notificação de DAR enviado para: ${emailDestino}`);
    } catch (error) {
        console.error(`Erro ao enviar e-mail de notificação para ${emailDestino}:`, error);
        throw error;
    }
}

/**
 * Envia um e-mail para um novo cliente de evento com um link para definir a sua senha.
 * (Nova função)
 */
// Corrigida: usa EVENTOS_BASE_URL ou BASE_URL e remove barra final
async function enviarEmailDefinirSenha(destinatario, nomeCliente, token) {
  const baseUrlRaw = process.env.EVENTOS_BASE_URL || process.env.BASE_URL || '';
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');
  const linkDefinirSenha = `${baseUrl}/definir-senha-evento.html?token=${token}`;

  const mailOptions = {
    from: `"Sistema CIPT" <${process.env.EMAIL_USER}>`,
    to: destinatario,
    subject: 'Crie sua Senha de Acesso - Evento no CIPT',
    html: `
      <h1>Olá, ${nomeCliente}!</h1>
      <p>Seu cadastro para o aluguel de espaço para evento no Centro de Inovação foi realizado com sucesso.</p>
      <p>Para gerenciar suas DARs e informações, crie sua senha:</p>
      <p><a href="${linkDefinirSenha}" style="background:#0056a0;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Criar Minha Senha</a></p>
      <p>Se você não solicitou este cadastro, ignore este e-mail.</p>
      <p><strong>Equipe do Centro de Inovação do Jaraguá</strong></p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`E-mail para definir senha enviado para ${destinatario}`);
  } catch (error) {
    console.error(`Erro ao enviar e-mail de definição de senha para ${destinatario}:`, error);
    throw new Error('Falha ao enviar e-mail de definição de senha.');
  }
}

// Exporta TODAS as funções para que possam ser usadas em outros arquivos
module.exports = { 
    enviarEmailNovaDar,
    enviarEmailRedefinicao, 
    enviarEmailPrimeiroAcesso,
    enviarEmailNotificacaoDar,
    enviarEmailDefinirSenha  
};
