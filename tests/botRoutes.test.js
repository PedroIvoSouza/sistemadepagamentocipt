const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const supertest = require('supertest');
const { codigoBarrasParaLinhaDigitavel } = require('../src/utils/boleto');

const DB_PATH = path.join(__dirname, 'bot-test.db');
try { fs.unlinkSync(DB_PATH); } catch {}
process.env.SQLITE_PATH = DB_PATH;
process.env.BOT_SHARED_KEY = 'secret';

const BARCODE = '12345678901234567890123456789012345678901234';
const EXPECTED = codigoBarrasParaLinhaDigitavel(BARCODE);
const MSISDN = '5599999999999';

const sefazService = require('../src/services/sefazService');
mock.method(sefazService, 'emitirGuiaSefaz', async () => ({
  numeroGuia: '123',
  pdfBase64: 'pdf',
  codigoBarras: BARCODE,
}));
mock.method(sefazService, 'buildSefazPayloadPermissionario', () => ({}));
mock.method(sefazService, 'buildSefazPayloadEvento', () => ({}));

const tokenUtils = require('../src/utils/token');
mock.method(tokenUtils, 'gerarTokenDocumento', async () => 'token');
mock.method(tokenUtils, 'imprimirTokenEmPdf', async pdf => pdf);

const botRoutes = require('../src/api/botRoutes');
const app = express();
app.use(express.json());
app.use('/api/bot', botRoutes);
const request = supertest(app);

const db = new sqlite3.Database(DB_PATH);
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}
async function reset() {
  await run(`CREATE TABLE IF NOT EXISTS permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, telefone TEXT);`);
  await run(`CREATE TABLE IF NOT EXISTS dars (
    id INTEGER PRIMARY KEY,
    permissionario_id INTEGER,
    valor REAL,
    data_vencimento TEXT,
    status TEXT,
    mes_referencia INTEGER,
    ano_referencia INTEGER,
    numero_documento TEXT,
    linha_digitavel TEXT,
    codigo_barras TEXT,
    pdf_url TEXT
  );`);
  await run('DELETE FROM permissionarios');
  await run('DELETE FROM dars');
  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj, telefone) VALUES (1,'Perm','123','${MSISDN}')`);
  await run(`INSERT INTO dars (id, permissionario_id, valor, data_vencimento, status, mes_referencia, ano_referencia, codigo_barras) VALUES (1,1,100,'2025-12-31','Pendente',1,2025,'${BARCODE}')`);
}

test('GET /api/bot/dars/:id retorna linha_digitavel a partir do codigo_barras', async () => {
  await reset();
  const res = await request
    .get('/api/bot/dars/1')
    .set('X-Bot-Key', 'secret')
    .query({ msisdn: MSISDN });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.dar.linha_digitavel, EXPECTED);
});

test('GET /api/bot/dars/:id usa numero_documento quando codigo_barras é nulo', async () => {
  await reset();
  await run('UPDATE dars SET codigo_barras=NULL, numero_documento=? WHERE id=1', [BARCODE]);
  const res = await request
    .get('/api/bot/dars/1')
    .set('X-Bot-Key', 'secret')
    .query({ msisdn: MSISDN });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.dar.linha_digitavel, EXPECTED);
});

test('POST /api/bot/dars/:id/emit gera linha_digitavel quando apenas codigo_barras é retornado', async () => {
  await reset();
  const res = await request
    .post('/api/bot/dars/1/emit')
    .set('X-Bot-Key', 'secret')
    .send({ msisdn: MSISDN });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.linha_digitavel, EXPECTED);
  const row = await get('SELECT linha_digitavel FROM dars WHERE id = 1');
  assert.strictEqual(row.linha_digitavel, EXPECTED);
});

test('POST /api/bot/dars/:id/reemit também retorna linha_digitavel', async () => {
  await reset();
  await run(`UPDATE dars SET status='Emitido', numero_documento='old', linha_digitavel=NULL WHERE id=1`);
  const res = await request
    .post('/api/bot/dars/1/reemit')
    .set('X-Bot-Key', 'secret')
    .send({ msisdn: MSISDN });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.linha_digitavel, EXPECTED);
});
