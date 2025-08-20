// preparar_ambiente_chatbot.js
'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { emitirGuiaSefaz } = require('./src/services/sefazService');

// ---------- Config ----------
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, 'sistemacipt.db');

// Utilizadores de teste
const CNPJ_PERMISSIONARIO_TESTE = '04007216000130'; // CNPJ (com ou sem máscara)
const CPF_CLIENTE_EVENTO_TESTE  = '06483579454';    // CPF (com ou sem máscara)

// ---------- Helpers ----------
const onlyDigits = (s) => (s ?? '').toString().replace(/\D+/g, '');
const docOrThrow = (s) => {
  const d = onlyDigits(s);
  if (d.length !== 11 && d.length !== 14) {
    throw new Error(`Documento inválido: '${s}' -> '${d}'`);
  }
  return d;
};

// Expressão SQL para normalizar documento no SQLite (sem mexer na base)
const SQL_DOC_NORMALIZE = (col) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`;

// Datas úteis
const hoje = new Date();
const anoAtual = hoje.getFullYear();
const mesAtual = hoje.getMonth() + 1;
const mesPassado = mesAtual === 1 ? 12 : mesAtual - 1;
const anoMesPassado = mesAtual === 1 ? anoAtual - 1 : anoAtual;
const mesFuturo = mesAtual === 12 ? 1 : mesAtual + 1;
const anoMesFuturo = mesAtual === 12 ? anoAtual + 1 : anoAtual;

// ---------- DB (promisificado) ----------
const db = new sqlite3.Database(DB_PATH);
db.configure('busyTimeout', 8000); // ajuda em concorrência

const run = (sql, params=[]) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const get = (sql, params=[]) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) return reject(err);
    resolve(row);
  });
});

const all = (sql, params=[]) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) return reject(err);
    resolve(rows);
  });
});

const exec = (sql) => new Promise((resolve, reject) => {
  db.exec(sql, (err) => (err ? reject(err) : resolve()));
});

async function withTransaction(fn) {
  await run('PRAGMA foreign_keys = ON;');
  await run('BEGIN IMMEDIATE;');
  try {
    const result = await fn();
    await run('COMMIT;');
    return result;
  } catch (err) {
    try { await run('ROLLBACK;'); } catch {}
    throw err;
  }
}

// ---------- Fetchers com documento desmascarado ----------
async function fetchPermissionarioByCNPJ(cnpjRaw) {
  const d = docOrThrow(cnpjRaw);
  return get(
    `SELECT * FROM permissionarios
     WHERE ${SQL_DOC_NORMALIZE('cnpj')} = ?
     LIMIT 1;`,
    [d]
  );
}

async function fetchClienteEventoByDocumento(docRaw) {
  const d = docOrThrow(docRaw);
  return get(
    `SELECT * FROM Clientes_Eventos
     WHERE ${SQL_DOC_NORMALIZE('documento')} = ?
     LIMIT 1;`,
    [d]
  );
}

// ---------- Limpeza ----------
async function limparDarsAntigas(permissionarioId, clienteEventoId) {
  console.log('--- ETAPA 1: Limpando DARs antigas dos utilizadores de teste ---');

  await withTransaction(async () => {
    // 1) DARs do permissionário
    if (permissionarioId) {
      await run('DELETE FROM dars WHERE permissionario_id = ?', [permissionarioId]);
      console.log(`- DARs do permissionário (ID ${permissionarioId}) limpas.`);
    }

    // 2) DARs do cliente de evento (associações + eventos)
    if (clienteEventoId) {
      const eventos = await all('SELECT id FROM Eventos WHERE id_cliente = ?', [clienteEventoId]);
      if (eventos.length) {
        const eventosIds = eventos.map(e => e.id);

        // DARs vinculadas aos eventos
        const darsEventos = await all(
          `SELECT id_dar FROM DARs_Eventos WHERE id_evento IN (${eventosIds.map(()=>'?').join(',')})`,
          eventosIds
        );
        const darsIds = darsEventos.map(de => de.id_dar);

        if (darsIds.length) {
          await run(`DELETE FROM dars WHERE id IN (${darsIds.map(()=>'?').join(',')})`, darsIds);
          console.log(`- ${darsIds.length} DAR(s) dos eventos do cliente (ID ${clienteEventoId}) limpas.`);
        }

        await run(`DELETE FROM DARs_Eventos WHERE id_evento IN (${eventosIds.map(()=>'?').join(',')})`, eventosIds);
        await run(`DELETE FROM Eventos WHERE id IN (${eventosIds.map(()=>'?').join(',')})`, eventosIds);
        console.log(`- ${eventosIds.length} evento(s) do cliente (ID ${clienteEventoId}) removidos.`);
      } else {
        console.log(`- Nenhum evento para o cliente (ID ${clienteEventoId}).`);
      }
    }
  });

  console.log('Limpeza concluída.');
}

// ---------- Geração ----------
async function gerarDarsDeTeste(permissionario, clienteEvento) {
  console.log('\n--- ETAPA 2: Gerando novas DARs de teste na SEFAZ ---');

  await withTransaction(async () => {
    // ===== Permissionário =====
    if (permissionario) {
      const permDoc = docOrThrow(permissionario.cnpj);
      const permNome = permissionario.nome_empresa || permissionario.nome || 'Permissionário (sem nome)';

      // DAR vencida
      console.log('\nGerando DAR Vencida para o Permissionário...');
      const darVencidaPerm = {
        valor: 150.50,
        data_vencimento: `${anoMesPassado}-${String(mesPassado).padStart(2, '0')}-10`,
        mes_referencia: mesPassado, ano_referencia: anoMesPassado
      };

      const sefazVencidaPerm = await emitirGuiaSefaz(
        { documento: permDoc, nome: permNome },
        darVencidaPerm
      );

      const insVencida = await run(
        `INSERT INTO dars 
         (permissionario_id, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, 
          numero_documento, linha_digitavel, codigo_barras, pdf_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          permissionario.id, 'Permissionario', darVencidaPerm.valor,
          darVencidaPerm.mes_referencia, darVencidaPerm.ano_referencia,
          darVencidaPerm.data_vencimento, 'Vencido',
          sefazVencidaPerm.numeroDocumento, sefazVencidaPerm.linhaDigitavel,
          sefazVencidaPerm.codigoBarras, sefazVencidaPerm.urlPdf
        ]
      );
      console.log(`- DAR Vencida do Permissionário criada (id=${insVencida.lastID}).`);

      // DAR vigente
      console.log('Gerando DAR Vigente para o Permissionário...');
      const darVigentePerm = {
        valor: 180.75,
        data_vencimento: `${anoMesFuturo}-${String(mesFuturo).padStart(2, '0')}-10`,
        mes_referencia: mesFuturo, ano_referencia: anoMesFuturo
      };

      const sefazVigentePerm = await emitirGuiaSefaz(
        { documento: permDoc, nome: permNome },
        darVigentePerm
      );

      const insVigente = await run(
        `INSERT INTO dars 
         (permissionario_id, tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status, 
          numero_documento, linha_digitavel, codigo_barras, pdf_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          permissionario.id, 'Permissionario', darVigentePerm.valor,
          darVigentePerm.mes_referencia, darVigentePerm.ano_referencia,
          darVigentePerm.data_vencimento, 'Pendente',
          sefazVigentePerm.numeroDocumento, sefazVigentePerm.linhaDigitavel,
          sefazVigentePerm.codigoBarras, sefazVigentePerm.urlPdf
        ]
      );
      console.log(`- DAR Vigente do Permissionário criada (id=${insVigente.lastID}).`);
    }

    // ===== Cliente de Evento =====
    if (clienteEvento) {
      const cliDoc = docOrThrow(clienteEvento.documento);
      const cliNome = clienteEvento.nome_razao_social || clienteEvento.nome || 'Cliente do Evento (sem nome)';

      // Evento passado + DAR vencida
      console.log('\nGerando DAR Vencida para o Cliente de Evento...');
      const darVencidaEvento = {
        valor: 500.00,
        data_vencimento: `${anoMesPassado}-${String(mesPassado).padStart(2, '0')}-15`,
        mes_referencia: mesPassado, ano_referencia: anoMesPassado
      };

      const evPast = await run(
        `INSERT INTO Eventos
           (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, valor_final, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [clienteEvento.id, 'Evento Passado (Teste Chatbot)', darVencidaEvento.data_vencimento, 1,
         darVencidaEvento.valor, darVencidaEvento.valor, 'Pendente']
      );

      const sefazVencidaEvento = await emitirGuiaSefaz(
        { documento: cliDoc, nome: cliNome },
        darVencidaEvento
      );

      const insDarVenc = await run(
        `INSERT INTO dars
           (tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status,
            numero_documento, linha_digitavel, codigo_barras, pdf_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Evento', darVencidaEvento.valor, darVencidaEvento.mes_referencia, darVencidaEvento.ano_referencia,
         darVencidaEvento.data_vencimento, 'Vencido',
         sefazVencidaEvento.numeroDocumento, sefazVencidaEvento.linhaDigitavel,
         sefazVencidaEvento.codigoBarras, sefazVencidaEvento.urlPdf]
      );

      await run(
        `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
         VALUES (?, ?, ?, ?, ?)`,
        [evPast.lastID, insDarVenc.lastID, 1, darVencidaEvento.valor, darVencidaEvento.data_vencimento]
      );

      console.log(`- DAR Vencida do Cliente de Evento criada (dar_id=${insDarVenc.lastID}, evento_id=${evPast.lastID}).`);

      // Evento futuro + DAR vigente
      console.log('Gerando DAR Vigente para o Cliente de Evento...');
      const darVigenteEvento = {
        valor: 750.25,
        data_vencimento: `${anoMesFuturo}-${String(mesFuturo).padStart(2, '0')}-15`,
        mes_referencia: mesFuturo, ano_referencia: anoMesFuturo
      };

      const evFut = await run(
        `INSERT INTO Eventos
           (id_cliente, nome_evento, datas_evento, total_diarias, valor_bruto, valor_final, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [clienteEvento.id, 'Evento Futuro (Teste Chatbot)', darVigenteEvento.data_vencimento, 1,
         darVigenteEvento.valor, darVigenteEvento.valor, 'Pendente']
      );

      const sefazVigenteEvento = await emitirGuiaSefaz(
        { documento: cliDoc, nome: cliNome },
        darVigenteEvento
      );

      const insDarVig = await run(
        `INSERT INTO dars
           (tipo_permissionario, valor, mes_referencia, ano_referencia, data_vencimento, status,
            numero_documento, linha_digitavel, codigo_barras, pdf_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Evento', darVigenteEvento.valor, darVigenteEvento.mes_referencia, darVigenteEvento.ano_referencia,
         darVigenteEvento.data_vencimento, 'Pendente',
         sefazVigenteEvento.numeroDocumento, sefazVigenteEvento.linhaDigitavel,
         sefazVigenteEvento.codigoBarras, sefazVigenteEvento.urlPdf]
      );

      await run(
        `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
         VALUES (?, ?, ?, ?, ?)`,
        [evFut.lastID, insDarVig.lastID, 1, darVigenteEvento.valor, darVigenteEvento.data_vencimento]
      );

      console.log(`- DAR Vigente do Cliente de Evento criada (dar_id=${insDarVig.lastID}, evento_id=${evFut.lastID}).`);
    }
  });

  console.log('\nGeração concluída.');
}

// ---------- Orquestração ----------
async function prepararAmbiente() {
  console.log('Iniciando preparação do ambiente de teste para o chatbot...');
  try {
    // Config DB
    await exec('PRAGMA journal_mode=WAL;');  // melhora concorrência
    await exec('PRAGMA foreign_keys = ON;');

    // Busca utilizadores de teste (tolerante a formatação)
    const permissionario = await fetchPermissionarioByCNPJ(CNPJ_PERMISSIONARIO_TESTE);
    const clienteEvento  = await fetchClienteEventoByDocumento(CPF_CLIENTE_EVENTO_TESTE);

    if (!permissionario) {
      console.warn(`AVISO: Permissionário de teste com CNPJ ${CNPJ_PERMISSIONARIO_TESTE} não encontrado.`);
    }
    if (!clienteEvento) {
      console.warn(`AVISO: Cliente de evento de teste com CPF ${CPF_CLIENTE_EVENTO_TESTE} não encontrado.`);
    }

    await limparDarsAntigas(permissionario?.id, clienteEvento?.id);
    await gerarDarsDeTeste(permissionario, clienteEvento);

    console.log('\n--- AMBIENTE DE TESTE PRONTO ---');
  } catch (err) {
    console.error('\n!!! ERRO NA PREPARAÇÃO DO AMBIENTE !!!\n', err);
  } finally {
    db.close((e) => {
      if (e) console.error('Erro ao fechar o banco:', e.message);
    });
  }
}

prepararAmbiente();
