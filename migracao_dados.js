// Em: migracao_dados.js

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./sistemacipt.db');
const SALT_ROUNDS = 10;

const ARQUIVO_PERMISSIONARIOS = 'permissionarios.xlsx - Permissionários.csv';
const ARQUIVO_DEVEDORES = 'Empresas do CIPT - Sistema de DARs.xlsx - EMPRESAS CIPT.csv';

// Função para limpar as tabelas
async function limparTabelas() {
    console.log('--- ETAPA 1: Limpando tabelas existentes ---');
    const tabelas = ['DARs_Eventos', 'Eventos', 'Clientes_Eventos', 'dars', 'permissionarios'];
    for (const tabela of tabelas) {
        await new Promise((resolve, reject) => {
            db.run(`DELETE FROM ${tabela}`, function(err) {
                if (err) {
                    console.error(`Erro ao limpar a tabela ${tabela}:`, err.message);
                    reject(err);
                } else {
                    console.log(`Tabela "${tabela}" limpa. ${this.changes} registos removidos.`);
                    db.run(`DELETE FROM sqlite_sequence WHERE name = '${tabela}'`, () => resolve());
                }
            });
        });
    }
}

// Função para importar os permissionários
async function importarPermissionarios() {
    console.log('\n--- ETAPA 2: Importando a nova lista de permissionários ---');
    const permissionarios = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(path.resolve(__dirname, ARQUIVO_PERMISSIONARIOS))
            .pipe(csv())
            .on('data', (row) => permissionarios.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    const senhaHashPadrao = await bcrypt.hash('mudar123', SALT_ROUNDS);
    let importados = 0;

    for (const p of permissionarios) {
        const cnpjLimpo = p.cnpj ? p.cnpj.replace(/\D/g, '') : null;
        if (!cnpjLimpo || cnpjLimpo.length !== 14) {
            console.warn(`AVISO: CNPJ inválido ou ausente para "${p.nome_empresa}". Permissionário não importado.`);
            continue;
        }

        const sql = `INSERT INTO permissionarios (nome_empresa, cnpj, email, telefone, numero_sala, senha_hash, primeiro_acesso) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await new Promise((resolve) => {
            db.run(sql, [p.nome_empresa, cnpjLimpo, p.email, p.telefone, p.numero_sala, senhaHashPadrao, 1], (err) => {
                if (err) {
                    console.error(`Erro ao importar ${p.nome_empresa}:`, err.message);
                } else {
                    importados++;
                }
                resolve();
            });
        });
    }
    console.log(`${importados} de ${permissionarios.length} permissionários importados com sucesso.`);
}

// Função para GERAR REGISTOS de DARs em atraso
async function gerarDarsAtrasadas() {
    console.log('\n--- ETAPA 3: Criando registos de DARs para meses em atraso ---');
    const devedores = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(path.resolve(__dirname, ARQUIVO_DEVEDORES))
            .pipe(csv())
            .on('data', (row) => devedores.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    let darsCriadas = 0;

    for (const dev of devedores) {
        const mesesDevendo = dev['Meses Devendo'];
        const cnpjLimpo = dev.CNPJ ? dev.CNPJ.replace(/\D/g, '') : null;

        if (!cnpjLimpo || !mesesDevendo || mesesDevendo.toLowerCase().startsWith('quitado')) {
            continue;
        }

        const permissionario = await new Promise((resolve, reject) => {
            db.get('SELECT id, valor_aluguel FROM permissionarios WHERE cnpj = ?', [cnpjLimpo], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!permissionario || !permissionario.valor_aluguel) {
            console.warn(`AVISO: Permissionário com CNPJ ${cnpjLimpo} (${dev.Empresas}) não encontrado ou sem valor de aluguel. Nenhuma DAR gerada.`);
            continue;
        }
        
        const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
        const anoAtual = new Date().getFullYear();

        await Promise.all(meses.map(async (mesNome, index) => {
            if (mesesDevendo.toLowerCase().includes(mesNome)) {
                const mesReferencia = index + 1;
                const anoReferencia = anoAtual;
                const dataVencimento = new Date(anoReferencia, mesReferencia - 1, 10).toISOString().split('T')[0];

                // LÓGICA ALTERADA: Inserimos a DAR sem dados da SEFAZ, apenas com o status "Vencido"
                const sql = `INSERT INTO dars (id_permissionario, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status) VALUES (?, ?, ?, ?, ?, ?, ?)`;
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
