import assert from 'assert';
import fetchMock from 'fetch-mock';
import NotificationService from '../src/services/NotificationService.js';

async function testeMensagemCorreta() {
  process.env.WHATSAPP_BOT_URL = 'https://example.com/send';
  process.env.WHATSAPP_BOT_TOKEN = 'token123';

  const nomeCliente = 'João da Silva';
  const numeroTermo = 'T-001';
  const nomeEvento = 'Evento Teste';
  const email = 'joao@example.com';

  const esperado = `Olá ${nomeCliente},\n\nO Termo de Permissão de Uso ${numeroTermo} para o evento ${nomeEvento} foi enviado para o e-mail ${email}.\nAssine o quanto antes para garantir a realização do seu evento no Centro de Inovação do Jaraguá.\n\nEquipe do CIPT.`;

  fetchMock.post(process.env.WHATSAPP_BOT_URL, (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.message, esperado, 'Mensagem de notificação incorreta');
    assert.strictEqual(opts.headers['Authorization'], `Bearer ${process.env.WHATSAPP_BOT_TOKEN}`);
    return { status: 200 };
  });

  const resultado = await NotificationService.sendTermoEnviado(nomeCliente, numeroTermo, nomeEvento, email);
  assert.strictEqual(resultado, true, 'Deve retornar true quando o envio é bem-sucedido');

  fetchMock.restore();
  console.log('Teste de mensagem correta passou.');
}

async function testeFalhaRede() {
  process.env.WHATSAPP_BOT_URL = 'https://example.com/falha';
  process.env.WHATSAPP_BOT_TOKEN = 'token123';

  fetchMock.post(process.env.WHATSAPP_BOT_URL, { throws: new Error('network error') });

  const resultado = await NotificationService.sendTermoEnviado('Cliente', '123', 'Evento', 'cliente@example.com');
  assert.strictEqual(resultado, false, 'Deve retornar false em caso de falha de rede');

  fetchMock.restore();
  console.log('Teste de falha de rede passou.');
}

async function testeRespostaInvalida() {
  process.env.WHATSAPP_BOT_URL = 'https://example.com/erro';
  process.env.WHATSAPP_BOT_TOKEN = 'token123';

  fetchMock.post(process.env.WHATSAPP_BOT_URL, 500);

  const resultado = await NotificationService.sendTermoEnviado('Cliente', '123', 'Evento', 'cliente@example.com');
  assert.strictEqual(resultado, false, 'Deve retornar false quando o bot responde com erro');

  fetchMock.restore();
  console.log('Teste de resposta inválida passou.');
}

await testeMensagemCorreta();
await testeFalhaRede();
await testeRespostaInvalida();
