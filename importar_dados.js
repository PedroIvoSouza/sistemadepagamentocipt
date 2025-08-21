const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
require('dotenv').config();

// Paths configuráveis via variáveis de ambiente
const DB_PATH = process.env.DB_PATH || './sistemacipt.db';
const API_BASE_URL = process.env.CNPJ_API_BASE_URL || 'https://brasilapi.com.br/api/cnpj/v1/';
const API_TIMEOUT = parseInt(process.env.CNPJ_API_TIMEOUT_MS || '5000', 10);
const LOG_FILE = process.env.IMPORT_LOG_FILE || path.join('logs', 'importacao.log');

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function logSuccess(message) {
    console.log(message);
    fs.appendFileSync(LOG_FILE, `[SUCESSO] ${message}\n`);
}

function logError(message) {
    console.error(message);
    fs.appendFileSync(LOG_FILE, `[ERRO] ${message}\n`);
}

const db = new sqlite3.Database(DB_PATH);

// Função para envolver db.run em uma Promise, para podermos usar await
function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
}

async function processarArquivo() {
    const results = [];
    console.log('Lendo arquivo empresas.csv...');
    const stream = fs.createReadStream('empresas.csv').pipe(csv());
    for await (const row of stream) {
        results.push(row);
    }

    if (results.length === 0) {
        console.log('Arquivo CSV está vazio.');
        return;
    }
    
    console.log(`Leitura concluída. ${results.length} empresas encontradas. Iniciando processo...`);

    let sucesso = 0;
    let falhas = 0;

    for (const row of results) {
        const cnpj = row['CNPJ'];
        const email = row['Email'];
        const numeroSala = row['Numero da Sala'];
        const aluguelRaw = row['Valor do Aluguel'];

        console.log(`\n--- Processando CNPJ (original): ${cnpj} ---`);

        if (!cnpj || !aluguelRaw || !numeroSala) {
            logError('   -> ERRO: Linha pulada. Um dos campos (CNPJ, Numero da Sala, Valor do Aluguel) está vazio no CSV.');
            falhas++;
            continue;
        }
        
        try {
            // --- LÓGICA DE CORREÇÃO DO CNPJ ---
            let cnpjLimpo = cnpj.replace(/[^\d]/g, ''); // Remove tudo que não é número

            if (cnpjLimpo.length === 13) {
                cnpjLimpo = '0' + cnpjLimpo;
                console.log(`   -> AVISO: CNPJ corrigido para 14 dígitos: ${cnpjLimpo}`);
            }
            // ------------------------------------

            const aluguelLimpo = aluguelRaw.replace("R$", "").replace(/\./g, "").replace(",", ".").trim();
            const aluguel = parseFloat(aluguelLimpo);

            if (isNaN(aluguel)) {
                throw new Error(`O valor do aluguel "[${aluguelRaw}]" não pôde ser convertido para um número.`);
            }

            const response = await axios.get(`${API_BASE_URL}${cnpjLimpo}`, { timeout: API_TIMEOUT });
            const razaoSocial = response.data.razao_social;
            
            const sql = `INSERT INTO permissionarios (nome_empresa, cnpj, email, numero_sala, valor_aluguel) VALUES (?, ?, ?, ?, ?)`;
            
            await dbRun(sql, [razaoSocial, cnpj, email, numeroSala, aluguel]);
            logSuccess(`   -> SUCESSO: Empresa "${razaoSocial}", Sala ${numeroSala}, Aluguel R$${aluguel.toFixed(2)} inserida.`);
            sucesso++;

        } catch (error) {
            const msg = error.response
                ? `${error.response.status} ${error.response.data?.message || ''}`
                : error.message;
            logError(`   -> FALHA ao processar CNPJ ${cnpj}: ${msg}`);
            falhas++;
        }
    }

    db.close();
    console.log(`\n--- Processo de importação finalizado. Sucesso: ${sucesso}, Falhas: ${falhas} ---`);
}

processarArquivo();
