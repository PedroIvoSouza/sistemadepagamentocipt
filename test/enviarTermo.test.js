import assert from 'assert';
import { composeDataFromEvent, enviarTermoParaAssinatura } from '../src/services/termoEventoPdfkitService.js';
import NotificationService from '../src/services/NotificationService.js';

const eventoBase = {
  valor: 2495,
  dataRealizacaoInicio: '2025-08-12T03:00:00Z',
  dataRealizacaoFim: '2025-08-12T15:00:00Z',
  dataMontagem: '2025-08-10T03:00:00Z',
  dataDesmontagem: '2025-08-13T03:00:00Z',
  saldoPagamento: 3000,
  clausulas: ['5.19', '5.20'],
  dars: [
    { dataVencimento: '2025-08-01T03:00:00Z' },
    { dataVencimento: '2025-08-20T03:00:00Z' }
  ],
  espacos: ['default']
};

(async () => {
  const dados = composeDataFromEvent(eventoBase);
  const token = 'TOKEN123';
  const nomeCliente = 'João da Silva';
  const numeroTermo = 'TERMO-123';
  const nomeEvento = 'Festa de Teste';
  const email = 'joao@example.com';

  const original = NotificationService.sendTermoEnviado;
  const mensagens = [];
  NotificationService.sendTermoEnviado = async (...args) => {
    const msg = await original(...args);
    mensagens.push(msg);
    return msg;
  };

  const pdf = await enviarTermoParaAssinatura(dados, token, nomeCliente, numeroTermo, nomeEvento, email);

  NotificationService.sendTermoEnviado = original;

  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 0, 'Deve gerar um PDF');
  assert.strictEqual(mensagens.length, 1, 'Deve enviar uma notificação');
  const esperado = `Olá ${nomeCliente},\n\nO Termo de Permissão de Uso ${numeroTermo} para o evento ${nomeEvento} foi enviado para o e-mail ${email}.\nAssine o quanto antes para garantir a realização do seu evento no Centro de Inovação do Jaraguá.\n\nEquipe do CIPT.`;
  assert.strictEqual(mensagens[0], esperado, 'Mensagem de notificação incorreta');

  console.log('Teste de notificação passou.');
})();
