const fs = require('fs');
const axios = require('axios');
const logger = require('../src/utils/logger');

function detectarCnpj(record) {
  for (const key of Object.keys(record)) {
    const value = String(record[key] || '');
    const match = value.match(/\d{2}\.??\d{3}\.??\d{3}\/?\d{4}-?\d{2}/);
    if (match) {
      return match[0].replace(/\D/g, '');
    }
  }
  return null;
}

async function completarEndereco(cnpj) {
  try {
    const { data } = await axios.get(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      { timeout: 5000 }
    );
    return {
      logradouro: data.logradouro || '',
      bairro: data.bairro || '',
      municipio: data.municipio || '',
      uf: data.uf || '',
      cep: data.cep || '',
    };
  } catch {
    return {};
  }
}

function lerCsv(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const linhas = txt.split(/\r?\n/).filter(Boolean);
  if (linhas.length === 0) return [];
  const cab = linhas.shift().split(',').map((h) => h.trim());
  return linhas.map((lin) => {
    const cols = lin.split(',');
    const obj = {};
    cab.forEach((h, i) => {
      obj[h] = cols[i] ? cols[i].trim() : '';
    });
    return obj;
  });
}

function escreverCsv(data) {
  if (data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const linhas = [headers.join(',')];
  for (const row of data) {
    const line = headers
      .map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`)
      .join(',');
    linhas.push(line);
  }
  return linhas.join('\n');
}

async function processarArquivos(files) {
  let todos = [];
  for (const f of files) {
    if (!fs.existsSync(f)) {
      logger.warn(`Arquivo não encontrado: ${f}`);
      continue;
    }
    logger.info(`Lendo arquivo ${f}`);
    const rows = lerCsv(f);
    logger.info(`Arquivo ${f} possui ${rows.length} registros`);
    todos = todos.concat(rows);
  }
  for (const reg of todos) {
    const cnpj = detectarCnpj(reg);
    reg.cnpj = cnpj || '';
    if (cnpj) {
      logger.info(`Enriquecendo dados para CNPJ ${cnpj}`);
      const addr = await completarEndereco(cnpj);
      Object.assign(reg, addr);
      reg.needsReview = ['logradouro', 'municipio', 'uf', 'cep'].some(
        (c) => !reg[c]
      );
      if (reg.needsReview) {
        logger.warn(`Endereço incompleto para ${cnpj}`);
      }
    } else {
      logger.warn('CNPJ não identificado em registro');
      reg.needsReview = true;
    }
  }
  return todos;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    logger.error('Uso: node scripts/processar_registros.js <arquivo1.csv> [arquivo2.csv ...]');
    process.exit(1);
  }
  logger.info(`Processando arquivos: ${files.join(', ')}`);
  const registros = await processarArquivos(files);
  const jsonOut = 'registros_unificados.json';
  const csvOut = 'registros_unificados.csv';
  fs.writeFileSync(jsonOut, JSON.stringify(registros, null, 2));
  fs.writeFileSync(csvOut, escreverCsv(registros));
  const incompletos = registros.filter((r) => r.needsReview);
  logger.info(`Processados ${registros.length} registros. ${incompletos.length} precisam de revisão.`);
  logger.info(`Arquivos gerados: ${jsonOut}, ${csvOut}`);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(`Erro ao processar registros: ${err.stack || err}`);
    process.exit(1);
  });
}

