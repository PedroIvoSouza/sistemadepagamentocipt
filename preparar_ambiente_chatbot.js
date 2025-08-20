// Em: preparar_ambiente_chatbot.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { emitirGuiaSefaz } = require('./src/services/sefazService');

const db = new sqlite3.Database('./sistemacipt.db');

// --- DADOS DOS SEUS UTILIZADORES DE TESTE ---
const CNPJ_PERMISSIONARIO_TESTE = '04007216000130';
const CPF_CLIENTE_EVENTO_TESTE = '06483579454';

// Função auxiliar para executar queries SQL com async/await
function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}


async function limparDarsAntigas(permissionarioId, clienteEventoId) {
    console.log('--- ETAPA 1: Limpando DARs antigas dos utilizadores de teste ---');

    // Limpa DARs do permissionário
    if (permissionarioId) {
        await runQuery('DELETE FROM dars WHERE permissionario_id = ?', [permissionarioId]);
        console.log(`- DARs do permissionário de teste (ID: ${permissionarioId}) limpas.`);
    }

    // Limpa DARs do cliente de evento (um processo mais complexo)
    if (clienteEventoId) {
        const eventos = await allQuery('SELECT id FROM Eventos WHERE id_cliente = ?', [clienteEventoId]);
        if (eventos.length > 0) {
            const eventosIds = eventos.map(e => e.id);
            const darsEventos = await allQuery(`SELECT id_dar FROM DARs_Eventos WHERE id_evento IN (${eventosIds.join(',')})`);
            
            if (darsEventos.length > 0) {
                const darsIds = darsEventos.map(de => de.id_dar);
                await runQuery(`DELETE FROM dars WHERE id IN (${darsIds.join(',')})`);
                console.log(`- DARs associadas a eventos do cliente de teste (ID: ${clienteEventoId}) limpas.`);
            }
            await runQuery(`DELETE FROM DARs_Eventos WHERE id_evento IN (${eventosIds.join(',')})`);
            await runQuery(`DELETE FROM Eventos WHERE id_cliente = ?`, [clienteEventoId]);
            console.log(`- Eventos do cliente de teste (ID: ${clienteEventoId}) limpos.`);
        }
    }
    console.log('Limpeza concluída.');
}

async function gerarDarsDeTeste(permissionario, clienteEvento) {
    console.log('\n--- ETAPA 2: Gerando novas DARs de teste na SEFAZ ---');

    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    const mesAtual = hoje.getMonth() + 1;
    const mesPassado = mesAtual === 1 ? 12 : mesAtual - 1;
    const anoMesPassado = mesAtual === 1 ? anoAtual - 1 : anoAtual;
    const mesFuturo = mesAtual === 12 ? 1 : mesAtual + 1;
    const anoMesFuturo = mesAtual === 12 ? anoAtual + 1 : anoAtual;

    // --- 1. DARs para o Permissionário ---
    if (permissionario) {
        // DAR Vencida
        console.log('\nGerando DAR Vencida para o Permissionário...');
        const darVencidaPerm = { valor: 150.50, data_vencimento: `${anoMesPassado}-${String(mesPassado).padStart(2, '0')}-10`, mes_referencia: mesPassado, ano_referencia: anoMesPassado };
        const sefazVencidaPerm = await emitirGuiaSefaz({ cnpj: permissionario.cnpj, nome_empresa: permissionario.nome_empresa }, darVencidaPerm);
        await runQuery(`INSERT INTO dars (permissionario_id, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, numero_documento, linha_digitavel, codigo_barras, pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [permissionario.id, 'Permissionario', darVencidaPerm.valor, darVencidaPerm.mes_referencia, darVencidaPerm.ano_referencia, darVencidaPerm.data_vencimento, 'Vencido', sefazVencidaPerm.numeroDocumento, sefazVencidaPerm.linhaDigitavel, sefazVencidaPerm.codigoBarras, sefazVencidaPerm.urlPdf]);
        console.log('- DAR Vencida do Permissionário criada com sucesso.');

        // DAR Vigente
        console.log('Gerando DAR Vigente para o Permissionário...');
        const darVigentePerm = { valor: 180.75, data_vencimento: `${anoMesFuturo}-${String(mesFuturo).padStart(2, '0')}-10`, mes_referencia: mesFuturo, ano_referencia: anoMesFuturo };
        const sefazVigentePerm = await emitirGuiaSefaz({ cnpj: permissionario.cnpj, nome_empresa: permissionario.nome_empresa }, darVigentePerm);
        await runQuery(`INSERT INTO dars (permissionario_id, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, numero_documento, linha_digitavel, codigo_barras, pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [permissionario.id, 'Permissionario', darVigentePerm.valor, darVigentePerm.mes_referencia, darVigentePerm.ano_referencia, darVigentePerm.data_vencimento, 'Pendente', sefazVigentePerm.numeroDocumento, sefazVigentePerm.linhaDigitavel, sefazVigentePerm.codigoBarras, sefazVigentePerm.urlPdf]);
        console.log('- DAR Vigente do Permissionário criada com sucesso.');
    }

    // --- 2. DARs para o Cliente de Evento ---
    if (clienteEvento) {
        // DAR Vencida (simulando um evento passado)
        console.log('\nGerando DAR Vencida para o Cliente de Evento...');
        const darVencidaEvento = { valor: 500.00, data_vencimento: `${anoMesPassado}-${String(mesPassado).padStart(2, '0')}-15`, mes_referencia: mesPassado, ano_referencia: anoMesPassado };
        const eventoVencidoResult = await runQuery(`INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, valor_final, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [clienteEvento.id, 'Evento Passado (Teste Chatbot)', darVencidaEvento.data_vencimento, 1, darVencidaEvento.valor, darVencidaEvento.valor, 'Pendente']);
        const sefazVencidaEvento = await emitirGuiaSefaz({ cnpj: clienteEvento.documento, nome_empresa: clienteEvento.nome_razao_social }, darVencidaEvento);
        const darVencidaResult = await runQuery(`INSERT INTO dars (tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, numero_documento, linha_digitavel, codigo_barras, pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['Evento', darVencidaEvento.valor, darVencidaEvento.mes_referencia, darVencidaEvento.ano_referencia, darVencidaEvento.data_vencimento, 'Vencido', sefazVencidaEvento.numeroDocumento, sefazVencidaEvento.linhaDigitavel, sefazVencidaEvento.codigoBarras, sefazVencidaEvento.urlPdf]);
        await runQuery(`INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`,
            [eventoVencidoResult.lastID, darVencidaResult.lastID, 1, darVencidaEvento.valor, darVencidaEvento.data_vencimento]);
        console.log('- DAR Vencida do Cliente de Evento criada com sucesso.');

        // DAR Vigente (simulando um evento futuro)
        console.log('Gerando DAR Vigente para o Cliente de Evento...');
        const darVigenteEvento = { valor: 750.25, data_vencimento: `${anoMesFuturo}-${String(mesFuturo).padStart(2, '0')}-15`, mes_referencia: mesFuturo, ano_referencia: anoMesFuturo };
        const eventoVigenteResult = await runQuery(`INSERT INTO Eventos (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, valor_final, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [clienteEvento.id, 'Evento Futuro (Teste Chatbot)', darVigenteEvento.data_vencimento, 1, darVigenteEvento.valor, darVigenteEvento.valor, 'Pendente']);
        const sefazVigenteEvento = await emitirGuiaSefaz({ cnpj: clienteEvento.documento, nome_empresa: clienteEvento.nome_razao_social }, darVigenteEvento);
        const darVigenteResult = await runQuery(`INSERT INTO dars (tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, numero_documento, linha_digitavel, codigo_barras, pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['Evento', darVigenteEvento.valor, darVigenteEvento.mes_referencia, darVigenteEvento.ano_referencia, darVigenteEvento.data_vencimento, 'Pendente', sefazVigenteEvento.numeroDocumento, sefazVigenteEvento.linhaDigitavel, sefazVigenteEvento.codigoBarras, sefazVigenteEvento.urlPdf]);
        await runQuery(`INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento) VALUES (?, ?, ?, ?, ?)`,
            [eventoVigenteResult.lastID, darVigenteResult.lastID, 1, darVigenteEvento.valor, darVigenteEvento.data_vencimento]);
        console.log('- DAR Vigente do Cliente de Evento criada com sucesso.');
    }
}


// Executa o fluxo completo
async function prepararAmbiente() {
    try {
        console.log('Iniciando preparação do ambiente de teste para o chatbot...');
        
        // Busca os IDs dos utilizadores de teste
        const permissionario = await getQuery('SELECT * FROM permissionarios WHERE cnpj = ?', [CNPJ_PERMISSIONARIO_TESTE]);
        const clienteEvento = await getQuery('SELECT * FROM Clientes_Eventos WHERE documento = ?', [CPF_CLIENTE_EVENTO_TESTE]);

        if (!permissionario) {
            console.warn(`AVISO: Permissionário de teste com CNPJ ${CNPJ_PERMISSIONARIO_TESTE} não encontrado.`);
        }
        if (!clienteEvento) {
            console.warn(`AVISO: Cliente de evento de teste com CPF ${CPF_CLIENTE_EVENTO_TESTE} não encontrado.`);
        }

        await limparDarsAntigas(permissionario?.id, clienteEvento?.id);
        await gerarDarsDeTeste(permissionario, clienteEvento);
        
        db.close((err) => {
            if (err) console.error('Erro ao fechar o banco:', err.message);
            else console.log('\n--- AMBIENTE DE TESTE PRONTO ---');
        });

    } catch (error) {
        console.error('\n!!! OCORREU UM ERRO DURANTE A PREPARAÇÃO DO AMBIENTE !!!', error);
        db.close();
    }
}

prepararAmbiente();
