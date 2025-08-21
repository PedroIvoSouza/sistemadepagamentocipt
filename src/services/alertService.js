const nodemailer = require('nodemailer');
require('dotenv').config();

let transporter;
if (process.env.EMAIL_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

async function enviarAlerta(assunto, mensagem) {
  try {
    if (!transporter) return;
    const para = process.env.ALERT_EMAIL;
    if (!para) return;
    await transporter.sendMail({
      from: `"Sistema CIPT" <${process.env.EMAIL_USER}>`,
      to: para,
      subject: assunto,
      text: mensagem,
    });
  } catch (err) {
    console.error('Falha ao enviar alerta crítico:', err);
  }
}

module.exports = { enviarAlerta };
