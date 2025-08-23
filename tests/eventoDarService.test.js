const test = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3').verbose();
const { criarEventoComDars, atualizarEventoComDars } = require('../src/services/eventoDarService');
process.env.COD_IBGE_MUNICIPIO = process.env.COD_IBGE_MUNICIPIO || '0000000';
process.env.RECEITA_CODIGO_EVENTO = process.env.RECEITA_CODIGO_EVENTO || '12345';

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function createDb() {
  const db = new sqlite3.Database(':memory:');
  return db;
}

async function setupSchema(db) {
  await run(db, `CREATE TABLE Clientes_Eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome_razao_social TEXT,
    documento TEXT,
    endereco TEXT,
    cep TEXT
  );`);
  await run(db, `CREATE TABLE Eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_cliente INTEGER,
    nome_evento TEXT,
    espaco_utilizado TEXT,
    area_m2 REAL,
    datas_evento TEXT,
    data_vigencia_final TEXT,
    total_diarias INTEGER,
    valor_bruto REAL,
    tipo_desconto TEXT,
    desconto_manual REAL,
    valor_final REAL,
    numero_oficio_sei TEXT,
    hora_inicio TEXT,
    hora_fim TEXT,
    hora_montagem TEXT,
    hora_desmontagem TEXT,
    numero_processo TEXT,
    numero_termo TEXT,
    evento_gratuito INTEGER DEFAULT 0,
    justificativa_gratuito TEXT,
    status TEXT
  );`);
  await run(db, `CREATE TABLE dars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    valor REAL,
    data_vencimento TEXT,
    status TEXT,
    mes_referencia INTEGER,
    ano_referencia INTEGER,
    permissionario_id INTEGER,
    tipo_permissionario TEXT,
    numero_documento TEXT,
    pdf_url TEXT
  );`);
  await run(db, `CREATE TABLE DARs_Eventos (
    id_evento INTEGER,
    id_dar INTEGER,
    numero_parcela INTEGER,
    valor_parcela REAL,
    data_vencimento TEXT
  );`);
}

const helpers = {
  emitirGuiaSefaz: async () => ({ numeroGuia: '123', pdfBase64: 'pdf' }),
  gerarTokenDocumento: async () => 'token',
  imprimirTokenEmPdf: async (pdf, token) => `${pdf}-${token}`,
};

const failingHelpers = {
  emitirGuiaSefaz: async () => { throw new Error('falha'); },
  gerarTokenDocumento: async () => 'token',
  imprimirTokenEmPdf: async (pdf, token) => `${pdf}-${token}`,
};

async function seedCliente(db) {
  await run(db, `INSERT INTO Clientes_Eventos (nome_razao_social, documento, endereco, cep) VALUES ('Cliente', '12345678901', 'Rua A', '12345000');`);
}

test('criarEventoComDars insere evento e dars', async () => {
  const db = createDb();
  await setupSchema(db);
  await seedCliente(db);
  const data = {
    idCliente: 1,
    nomeEvento: 'Show',
    numeroOficioSei: null,
    espacosUtilizados: ['Auditório'],
    datasEvento: ['2025-10-10'],
    totalDiarias: 1,
    valorBruto: 100,
    tipoDescontoAuto: 'Geral',
    descontoManualPercent: 0,
    valorFinal: 100,
    parcelas: [{ valor: 100, vencimento: '2025-09-01' }],
  };
  const id = await criarEventoComDars(db, data, helpers);
  assert.strictEqual(id, 1);
  const eventos = await all(db, 'SELECT * FROM Eventos');
  assert.strictEqual(eventos.length, 1);
  const dars = await all(db, 'SELECT * FROM dars');
  assert.strictEqual(dars.length, 1);
  await new Promise(res => db.close(res));
});

test('criarEventoComDars faz rollback em falha', async () => {
  const db = createDb();
  await setupSchema(db);
  await seedCliente(db);
  const data = {
    idCliente: 1,
    nomeEvento: 'Show',
    numeroOficioSei: null,
    espacosUtilizados: ['Auditório'],
    datasEvento: ['2025-10-10'],
    totalDiarias: 1,
    valorBruto: 100,
    tipoDescontoAuto: 'Geral',
    descontoManualPercent: 0,
    valorFinal: 100,
    parcelas: [{ valor: 100, vencimento: '2025-09-01' }],
  };
  await assert.rejects(() => criarEventoComDars(db, data, failingHelpers));
  const eventos = await all(db, 'SELECT * FROM Eventos');
  assert.strictEqual(eventos.length, 0);
  const dars = await all(db, 'SELECT * FROM dars');
  assert.strictEqual(dars.length, 0);
  await new Promise(res => db.close(res));
});

test('atualizarEventoComDars substitui dars', async () => {
  const db = createDb();
  await setupSchema(db);
  await seedCliente(db);
  const data = {
    idCliente: 1,
    nomeEvento: 'Show',
    numeroOficioSei: null,
    espacosUtilizados: ['Auditório'],
    datasEvento: ['2025-10-10'],
    totalDiarias: 1,
    valorBruto: 100,
    tipoDescontoAuto: 'Geral',
    descontoManualPercent: 0,
    valorFinal: 100,
    parcelas: [{ valor: 100, vencimento: '2025-09-01' }],
  };
  const id = await criarEventoComDars(db, data, helpers);
  const updateData = {
    ...data,
    valorFinal: 200,
    parcelas: [
      { valor: 100, vencimento: '2025-09-01' },
      { valor: 100, vencimento: '2025-10-01' },
    ],
  };
  await atualizarEventoComDars(db, id, updateData, helpers);
  const dars = await all(db, 'SELECT * FROM dars');
  assert.strictEqual(dars.length, 2);
  await new Promise(res => db.close(res));
});

test('criarEventoComDars com evento gratuito não gera dars', async () => {
  const db = createDb();
  await setupSchema(db);
  await seedCliente(db);
  const data = {
    idCliente: 1,
    nomeEvento: 'Feira',
    datasEvento: ['2025-10-10'],
    totalDiarias: 1,
    valorBruto: 0,
    tipoDescontoAuto: 'Geral',
    descontoManualPercent: 0,
    valorFinal: 0,
    parcelas: [],
    eventoGratuito: true,
    justificativaGratuito: 'Cortesia'
  };
  const id = await criarEventoComDars(db, data, helpers);
  assert.strictEqual(id, 1);
  const eventos = await all(db, 'SELECT evento_gratuito, justificativa_gratuito FROM Eventos');
  assert.strictEqual(eventos[0].evento_gratuito, 1);
  assert.strictEqual(eventos[0].justificativa_gratuito, 'Cortesia');
  const dars = await all(db, 'SELECT * FROM dars');
  assert.strictEqual(dars.length, 0);
  await new Promise(res => db.close(res));
});

test('atualizarEventoComDars para evento gratuito remove dars', async () => {
  const db = createDb();
  await setupSchema(db);
  await seedCliente(db);
  const data = {
    idCliente: 1,
    nomeEvento: 'Show',
    datasEvento: ['2025-10-10'],
    totalDiarias: 1,
    valorBruto: 100,
    tipoDescontoAuto: 'Geral',
    descontoManualPercent: 0,
    valorFinal: 100,
    parcelas: [{ valor: 100, vencimento: '2025-09-01' }]
  };
  const id = await criarEventoComDars(db, data, helpers);
  const updateData = {
    idCliente: 1,
    nomeEvento: 'Show',
    datasEvento: ['2025-10-10'],
    totalDiarias: 1,
    valorBruto: 0,
    tipoDescontoAuto: 'Geral',
    descontoManualPercent: 0,
    valorFinal: 0,
    parcelas: [],
    eventoGratuito: true,
    justificativaGratuito: 'Isento'
  };
  await atualizarEventoComDars(db, id, updateData, helpers);
  const dars = await all(db, 'SELECT * FROM dars');
  assert.strictEqual(dars.length, 0);
  const eventos = await all(db, 'SELECT evento_gratuito, justificativa_gratuito FROM Eventos WHERE id = ?', [id]);
  assert.strictEqual(eventos[0].evento_gratuito, 1);
  assert.strictEqual(eventos[0].justificativa_gratuito, 'Isento');
  await new Promise(res => db.close(res));
});
