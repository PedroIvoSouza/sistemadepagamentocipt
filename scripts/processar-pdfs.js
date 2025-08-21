#!/usr/bin/env node
// scripts/processar-pdfs.js
// Itera sobre PDFs e extrai dados básicos de eventos.

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

// Converte string monetária brasileira para número (float)
function parseMoney(str) {
  const s = String(str || '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// Extrai dados relevantes do texto de um PDF
async function extrairDados(filePath) {
  const buf = fs.readFileSync(filePath);
  const { text } = await pdfParse(buf);

  const cliente = (text.match(/Cliente:\s*(.+)/i) || [])[1] || null;
  const documento = (text.match(/(?:CNPJ|CPF):\s*([\d./-]+)/i) || [])[1] || null;
  const valorStr = (text.match(/Valor:\s*R?\$?\s*([\d.,]+)/i) || [])[1];
  const valor = valorStr ? parseMoney(valorStr) : null;

  let tipoEvento = 'pago';
  if (!valor || valor === 0 || /gratuito/i.test(text)) tipoEvento = 'gratuito';

  const telefone = (text.match(/(?:Telefone|Tel\.?):\s*([\d\s()\-]+)/i) || [])[1];
  const email = (text.match(/E-?mail:\s*([^\s]+)/i) || [])[1] || null;
  const endereco = (text.match(/Endere[çc]o:\s*(.+)/i) || [])[1] || null;

  const pendentes = [];
  if (!telefone) pendentes.push('telefone');
  if (!email) pendentes.push('email');
  if (!endereco) pendentes.push('endereco');

  return {
    tipoEvento,
    cliente: cliente && cliente.trim(),
    documento: documento && documento.trim(),
    valor,
    telefone: telefone && telefone.replace(/\D/g, ''),
    email,
    endereco: endereco && endereco.trim(),
    pendentes
  };
}

// Diretório de PDFs via argumento ou raiz do projeto
const dir = process.argv[2] || path.resolve(__dirname, '..');

(async () => {
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
  const resultados = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const dados = await extrairDados(fullPath);
      resultados.push({ arquivo: file, ...dados });
    } catch (err) {
      console.error(`[ERRO] Falha ao processar ${file}:`, err.message);
    }
  }
  console.log(JSON.stringify(resultados, null, 2));
})();
