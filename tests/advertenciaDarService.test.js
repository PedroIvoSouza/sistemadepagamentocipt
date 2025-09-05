const test = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3').verbose();

process.env.COD_IBGE_MUNICIPIO = process.env.COD_IBGE_MUNICIPIO || '0000000';
process.env.RECEITA_CODIGO_EVENTO = process.env.RECEITA_CODIGO_EVENTO || '12345';

const { emitirDarAdvertencia } = require('../src/services/eventoDarService');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

test('emitirDarAdvertencia cria dar e vincula à advertencia', async () => {
  const db = new sqlite3.Database(':memory:');

  await run(db, `CREATE TABLE Clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome_razao_social TEXT,
    documento TEXT,
    endereco TEXT,
    cep TEXT
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
    pdf_url TEXT,
    linha_digitavel TEXT,
    codigo_barras TEXT,
    data_emissao TEXT
  );`);
  await run(db, `CREATE TABLE Advertencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER,
    cliente_id INTEGER,
    valor_multa REAL,
    dar_id INTEGER
  );`);

  await run(db, `INSERT INTO Clientes (nome_razao_social, documento, endereco, cep) VALUES ('Cliente', '12345678901', 'Rua A', '12345000');`);
  await run(db, `INSERT INTO Advertencias (evento_id, cliente_id) VALUES (1, 1);`);

  const helpers = {
    emitirGuiaSefaz: async () => ({ numeroGuia: '999', pdfBase64: 'PDF', linhaDigitavel: 'LD', codigoBarras: 'CB' }),
    gerarTokenDocumento: async () => 'TK',
    imprimirTokenEmPdf: async (pdf, token) => `${pdf}-${token}`,
  };

  const advertencia = { id: 1, cliente_id: 1, nome_evento: 'Show' };
  await emitirDarAdvertencia(advertencia, 150, { db, helpers, hoje: new Date('2025-03-03') });

  const adv = await get(db, 'SELECT * FROM Advertencias WHERE id = 1');
  assert.ok(adv.dar_id);
  const dar = await get(db, 'SELECT * FROM dars WHERE id = ?', [adv.dar_id]);
  assert.strictEqual(dar.valor, 150);
  assert.strictEqual(dar.data_vencimento, '2025-03-10');
  assert.strictEqual(dar.status, 'Emitido');
  assert.strictEqual(dar.numero_documento, '999');
   assert.strictEqual(dar.linha_digitavel, 'LD');
   assert.strictEqual(dar.codigo_barras, 'CB');
  await new Promise(res => db.close(res));
});

