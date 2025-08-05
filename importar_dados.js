const fs = require('fs');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const db = new sqlite3.Database('./sistemacipt.db');

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

    for (const row of results) {
        const cnpj = row['CNPJ'];
        const email = row['Email'];
        const numeroSala = row['Numero da Sala'];
        const aluguelRaw = row['Valor do Aluguel'];

        console.log(`\n--- Processando CNPJ (original): ${cnpj} ---`);

        if (!cnpj || !aluguelRaw || !numeroSala) {
            console.error('   -> ERRO: Linha pulada. Um dos campos (CNPJ, Numero da Sala, Valor do Aluguel) está vazio no CSV.');
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

            const response = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpjLimpo}`);
            const razaoSocial = response.data.razao_social;
            
            const sql = `INSERT INTO permissionarios (nome_empresa, cnpj, email, numero_sala, valor_aluguel) VALUES (?, ?, ?, ?, ?)`;
            
            await dbRun(sql, [razaoSocial, cnpj, email, numeroSala, aluguel]);
            console.log(`   -> SUCESSO: Empresa "${razaoSocial}", Sala ${numeroSala}, Aluguel R$${aluguel.toFixed(2)} inserida.`);

        } catch (error) {
            console.error(`   -> FALHA ao processar CNPJ ${cnpj}: ${error.message}`);
        }
    }

    db.close();
    console.log('\n--- Processo de importação finalizado. ---');
}

processarArquivo();