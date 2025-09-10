export default class NotificationService {
  static async sendTermoEnviado(nomeCliente, numeroTermo, nomeEvento, email) {
    const mensagem = `Olá ${nomeCliente},\n\nO Termo de Permissão de Uso ${numeroTermo} para o evento ${nomeEvento} foi enviado para o e-mail ${email}.\nAssine o quanto antes para garantir a realização do seu evento no Centro de Inovação do Jaraguá.\n\nEquipe do CIPT.`;
    // Aqui poderia haver uma integração real com serviço de e-mail ou outra notificação
    return mensagem;
  }
}
