const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

test('atualizarUIEvento renders download button when termo está assinado', async () => {
  // Prepare DOM container
  const dom = new JSDOM(`<div id="btns-123"></div>`);
  const document = dom.window.document;

  // Context for the function execution
  const context = {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        status: 'assinado',
        signed_pdf_public_url: 'https://example.com/termo.pdf'
      })
    }),
    headers: {},
    document,
    console
  };
  vm.createContext(context);

  // Extract and run atualizarUIEvento from the HTML file
  const html = fs.readFileSync(path.resolve(__dirname, '../public/eventos/meus-eventos.html'), 'utf8');
  const start = html.indexOf('async function atualizarUIEvento');
  const end = html.indexOf('window.addEventListener', start);
  const functionCode = html.slice(start, end);
  vm.runInContext(functionCode, context);

  await context.atualizarUIEvento(123);

  const btns = document.getElementById('btns-123');
  assert.ok(btns.querySelector('.btn-success'), 'expected download button to be rendered');
  assert.ok(!btns.querySelector('.btn-primary'), 'sign button should not be rendered');
});
