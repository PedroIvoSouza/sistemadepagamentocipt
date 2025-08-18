// Em: migracao_final.js

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./sistemacipt.db');
const SALT_ROUNDS = 10;

const ARQUIVO_PERMISSIONARIOS = 'permissionarios.xlsx';
const ARQUIVO_DEVEDORES = 'Empresas do CIPT - Sistema de DARs.xlsx';

// Função para ler dados de um ficheiro XLSX, tratando todos os dados como texto
function lerPlanilha(nomeArquivo, nomeAba) {
    try {
        const caminhoCompleto = path.resolve(__dirname, nomeArquivo);
        const workbook = xlsx.readFile(caminhoCompleto);
        const sheet = workbook.Sheets[nomeAba];
        if (!sheet) throw new Error(`Aba "${nomeAba}" não encontrada no ficheiro "${nomeArquivo}"`);
        // CORREÇÃO: A opção { raw: true } garante que os dados (como o CNPJ com '0' no início) sejam lidos como texto.
        return xlsx.utils.sheet_to_json(sheet, { raw: true });
    } catch (error) {
        console.error(`Erro ao ler o ficheiro "${nomeArquivo}":`, error.message);
        process.exit(1);
    }
}

// Função para limpar as tabelas
async function limparTabelas() {
    console.log('--- ETAPA 1: Limpando tabelas existentes ---');
    const tabelas = ['DARs_Eventos', 'Eventos', 'Clientes_Eventos', 'dars', 'permissionarios'];
    for (const tabela of tabelas) {
        await new Promise((resolve) => {
            db.run(`DELETE FROM ${tabela}`, function(err) {
                if (err) console.warn(`Aviso ao limpar a tabela ${tabela}:`, err.message);
                else console.log(`Tabela "${tabela}" limpa. ${this.changes} registos removidos.`);
                db.run(`DELETE FROM sqlite_sequence WHERE name = '${tabela}'`, () => resolve());
            });
        });
    }
}

// Função para importar os permissionários com dados combinados
async function importarPermissionarios() {
    console.log('\n--- ETAPA 2: Combinando dados e importando permissionários ---');
    
    const permissionariosBase = lerPlanilha(ARQUIVO_PERMISSIONARIOS, 'Permissionários');
    const dadosFinanceiros = lerPlanilha(ARQUIVO_DEVEDORES, 'EMPRESAS CIPT');

    const mapaFinanceiro = new Map();
    dadosFinanceiros.forEach(item => {
        const cnpjLimpo = item.CNPJ ? String(item.CNPJ).replace(/\D/g, '') : null;
        if (cnpjLimpo) {
            mapaFinanceiro.set(cnpjLimpo, {
                valor_aluguel: item['Valor do Aluguel'],
                meses_devendo: item['Meses Devendo']
            });
        }
    });

    const senhaHashPadrao = await bcrypt.hash('mudar123', SALT_ROUNDS);
    let importados = 0;

    for (const p of permissionariosBase) {
        const cnpjLimpo = p.cnpj ? String(p.cnpj).replace(/\D/g, '') : null;
        if (!cnpjLimpo || (cnpjLimpo.length !== 14 && cnpjLimpo.length !== 11)) { // Aceita CPF ou CNPJ
            console.warn(`AVISO: Documento inválido para "${p.nome_empresa}". Não importado.`);
            continue;
        }

        const dadosExtras = mapaFinanceiro.get(cnpjLimpo);
        // CORREÇÃO: Se não encontrar dados financeiros (como para a SECTI), atribui um valor padrão.
        const valorAluguel = (dadosExtras && dadosExtras.valor_aluguel) ? dadosExtras.valor_aluguel : 1500.00; // Valor padrão para SECTI e outros

        const sql = `INSERT INTO permissionarios (nome_empresa, cnpj, email, telefone, numero_sala, valor_aluguel, senha_hash, primeiro_acesso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await new Promise((resolve) => {
            db.run(sql, [p.nome_empresa, cnpjLimpo, p.email, p.telefone, p.numero_sala, valorAluguel, senhaHashPadrao, 1], (err) => {
                if (err) {
                    console.error(`Erro ao importar ${p.nome_empresa}:`, err.message);
                } else {
                    importados++;
                }
                resolve();
            });
        });
    }
    console.log(`${importados} de ${permissionariosBase.length} permissionários importados com sucesso.`);
}

// Função para gerar DARs em atraso
async function gerarDarsAtrasadas() {
    console.log('\n--- ETAPA 3: Criando registos de DARs para meses em atraso ---');
    const devedores = lerPlanilha(ARQUIVO_DEVEDORES, 'EMPRESAS CIPT');
    let darsCriadas = 0;

    for (const dev of devedores) {
        const mesesDevendo = dev['Meses Devendo'];
        const cnpjLimpo = dev.CNPJ ? String(dev.CNPJ).replace(/\D/g, '') : null;

        if (!cnpjLimpo || !mesesDevendo || String(mesesDevendo).toLowerCase().startsWith('quitado')) {
            continue;
        }

        const permissionario = await new Promise((resolve) => {
            db.get('SELECT id, valor_aluguel FROM permissionarios WHERE cnpj = ?', [cnpjLimpo], (err, row) => resolve(row));
        });

        if (!permissionario || !permissionario.valor_aluguel) {
            console.warn(`AVISO: Permissionário com CNPJ ${cnpjLimpo} (${dev.Empresas}) não encontrado na base após importação. Nenhuma DAR gerada.`);
            continue;
        }
        
        const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
        const anoAtual = new Date().getFullYear();

        await Promise.all(meses.map(async (mesNome, index) => {
            if (String(mesesDevendo).toLowerCase().includes(mesNome)) {
                const mesReferencia = index + 1;
                const anoReferencia = anoAtual;
                const dataVencimento = new Date(anoReferencia, mesReferencia - 1, 10).toISOString().split('T')[0];

                // CORREÇÃO: O nome da coluna é 'permissionario_id', não 'id_permissionario'.
                const sql = `INSERT INTO dars (permissionario_id, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?, ?)`;
                await new Promise((resolve) => {
                    db.run(sql, [permissionario.id, 'Permissionario', permissionario.valor_aluguel, mesReferencia, anoReferencia, dataVencimento, 'Vencido'], (err) => {
                        if (err) {
                             console.error(`Erro ao criar registo de DAR de ${mesNome}/${anoReferencia} para ${dev.Empresas}:`, err.message);
                        } else {
                            console.log(`- Registo de DAR Vencida (${mesNome}/${anoReferencia}) criado para ${dev.Empresas}.`);
                            darsCriadas++;
                        }
                        resolve();
                    });
                });
            }
        }));
    }
    console.log(`${darsCriadas} registos de DARs em atraso criados com sucesso.`);
}

// Executa o fluxo completo
async function runMigration() {
    try {
        db.serialize(async () => {
            await limparTabelas();
            await importarPermissionarios();
            await gerarDarsAtrasadas();
            
            db.close((err) => {
                if (err) console.error('Erro ao fechar o banco:', err.message);
                else console.log('\n--- MIGRAÇÃO CONCLUÍDA ---');
            });
        });
    } catch (error) {
        console.error('\n!!! OCORREU UM ERRO DURANTE A MIGRAÇÃO !!!', error);
        db.close();
    }
}

runMigration();
