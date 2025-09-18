const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function createMockFetch(responses) {
  const queue = Array.from(responses);
  return async () => {
    if (!queue.length) {
      throw new Error('Unexpected fetch invocation');
    }
    const response = queue.shift();
    return {
      ok: true,
      status: 200,
      json: async () => response,
    };
  };
}

async function flush(window, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

test('assistant widget sanitizes rendered messages', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://cipt.local/portal',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.localStorage = window.localStorage;
  global.navigator = window.navigator;

  window.fetch = createMockFetch([
    {
      audience: 'permissionario',
      context: {},
      suggestions: [
        { question: 'Baixar uma DAR pendente' },
        { question: 'Emitir certidão' },
      ],
    },
    {
      reply:
        'Aqui vai um resumo com **destaques**:\n1. Abrir o menu principal\n2. Escolher a opção correta\n\nCuidado com <script>alert(1)</script> & outras tags.',
    },
  ]);
  global.fetch = window.fetch;

  const scriptPath = path.resolve(__dirname, '../public/js/assistant-widget.js');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');
  window.eval(scriptContent);

  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flush(window);

  const launcher = window.document.querySelector('.assistant-launcher');
  assert.ok(launcher, 'launcher should be rendered');
  launcher.click();
  await flush(window);

  const textarea = window.document.getElementById('assistant-textarea');
  assert.ok(textarea, 'textarea should exist after initialization');
  textarea.value = '<script>alert("user")</script> & texto';

  const form = window.document.getElementById('assistant-form');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(window, 5);

  const messages = [...window.document.querySelectorAll('.assistant-message')];
  assert.ok(messages.length >= 3, 'expected greeting, user and assistant messages');

  messages.forEach((el) => {
    assert.ok(!el.innerHTML.includes('<script'), 'raw <script> should not appear in HTML');
  });

  const scriptsInMessages = window.document.querySelectorAll('.assistant-message script');
  assert.strictEqual(scriptsInMessages.length, 0, 'no script tags should be injected');

  const userMessage = messages.find((el) => el.classList.contains('user'));
  assert.ok(userMessage, 'user message should exist');
  assert.ok(
    userMessage.textContent.includes('<script>alert("user")</script> & texto'),
    'user message text should be preserved literally',
  );

  const assistantReply = messages.find(
    (el) => el.classList.contains('bot') && el.textContent.includes('Aqui vai um resumo'),
  );
  assert.ok(assistantReply, 'assistant reply should exist');
  assert.ok(
    assistantReply.textContent.includes('Cuidado com <script>alert(1)</script> & outras tags.'),
    'assistant reply should render as text without executing HTML',
  );

  const bold = assistantReply.querySelector('strong');
  assert.ok(bold, 'assistant reply should render strong elements from markdown');
  assert.strictEqual(bold.textContent, 'destaques');

  const orderedListItems = assistantReply.querySelectorAll('ol li');
  assert.strictEqual(orderedListItems.length, 2, 'assistant reply should render ordered list items');
  assert.ok(
    orderedListItems[0].textContent.startsWith('Abrir o menu principal'),
    'first list item should contain the first step',
  );
});
