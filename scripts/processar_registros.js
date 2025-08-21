const fs = require('fs');
const axios = require('axios');

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
      console.warn(`Arquivo não encontrado: ${f}`);
      continue;
    }
    todos = todos.concat(lerCsv(f));
  }
  for (const reg of todos) {
    const cnpj = detectarCnpj(reg);
    reg.cnpj = cnpj || '';
    if (cnpj) {
      const addr = await completarEndereco(cnpj);
      Object.assign(reg, addr);
      reg.needsReview = ['logradouro', 'municipio', 'uf', 'cep'].some(
        (c) => !reg[c]
      );
    } else {
      reg.needsReview = true;
    }
  }
  return todos;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Uso: node scripts/processar_registros.js <arquivo1.csv> [arquivo2.csv ...]');
    process.exit(1);
  }
  const registros = await processarArquivos(files);
  const jsonOut = 'registros_unificados.json';
  const csvOut = 'registros_unificados.csv';
  fs.writeFileSync(jsonOut, JSON.stringify(registros, null, 2));
  fs.writeFileSync(csvOut, escreverCsv(registros));
  const incompletos = registros.filter((r) => r.needsReview);
  console.log(`Processados ${registros.length} registros. ${incompletos.length} precisam de revisão.`);
  console.log(`Arquivos gerados: ${jsonOut}, ${csvOut}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao processar registros:', err.message || err);
    process.exit(1);
  });
}

