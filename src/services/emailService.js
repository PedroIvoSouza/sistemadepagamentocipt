const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

/**
 * Envia um e-mail de notificação sobre um novo DAR gerado.
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
 */
async function enviarEmailPrimeiroAcesso(emailDestino, token) {
    // MUDANÇA AQUI: O link agora aponta para a página de admin
    const link = `${process.env.BASE_URL}/admin/definir-senha.html?token=${token}`;
    
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
        // Silenciando o throw de erro aqui para não quebrar a criação do admin se o email falhar
    }
}

/**
 * Envia um e-mail de notificação de DAR a partir do painel do admin.
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

// Exporta TODAS as funções para que possam ser usadas em outros arquivos
module.exports = { 
    enviarEmailNovaDar,
    enviarEmailRedefinicao, 
    enviarEmailPrimeiroAcesso,
    enviarEmailNotificacaoDar  
};
