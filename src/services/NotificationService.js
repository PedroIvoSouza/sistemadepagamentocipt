export default class NotificationService {
  static async _postMessage(message) {
    const url = process.env.WHATSAPP_BOT_URL;
    const token = process.env.WHATSAPP_BOT_TOKEN;

    if (!url || !token) {
      console.error('Configurações de notificação ausentes.');
      return false;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ message })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('Falha ao enviar notificação:', response.status, errorText);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Erro ao enviar notificação:', error);
      return false;
    }
  }

  static async sendTermoEnviado(nomeCliente, numeroTermo, nomeEvento, email) {
    const mensagem = `Olá ${nomeCliente},\n\nO Termo de Permissão de Uso ${numeroTermo} para o evento ${nomeEvento} foi enviado para o e-mail ${email}.\nAssine o quanto antes para garantir a realização do seu evento no Centro de Inovação do Jaraguá.\n\nEquipe do CIPT.`;
    return await this._postMessage(mensagem);
  }
}
