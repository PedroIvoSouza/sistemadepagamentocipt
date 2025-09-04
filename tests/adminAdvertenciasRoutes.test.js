const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

function prepDb(dbPath) {
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;
  delete require.cache[require.resolve('../src/database/db')];
  const db = require('../src/database/db');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
  const get = (sql, params=[]) => new Promise((res, rej) => db.get(sql, params, (err,row)=> err?rej(err):res(row)));
  return { db, run, get };
}

test('POST cria advertencia grava clausulas e envia email', async () => {

  const dbPath = path.resolve(__dirname, 'test-advertencia-post.db');
  const { run, get } = prepDb(dbPath);

  await run(`CREATE TABLE Eventos (id INTEGER PRIMARY KEY, nome_evento TEXT, id_cliente INTEGER)`);
  await run(`CREATE TABLE Clientes_Eventos (id INTEGER PRIMARY KEY, nome_razao_social TEXT, email TEXT, documento TEXT)`);
  await run(`INSERT INTO Clientes_Eventos (id, nome_razao_social, email, documento) VALUES (1, 'Cliente', 'c@x.com', '123')`);
  await run(`INSERT INTO Eventos (id, nome_evento, id_cliente) VALUES (10, 'Evento X', 1)`);

  const mailPath = require.resolve('nodemailer');
  let mailSent = false;
  require.cache[mailPath] = { exports: { createTransport: () => ({ sendMail: async () => { mailSent = true; } }) } };

  process.env.SMTP_HOST = 'h';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'u';
  process.env.SMTP_PASS = 'p';

  const pdfSvcPath = path.resolve(__dirname, '../src/services/advertenciaPdfService.js');
  let pdfArgs;
  const fakePath = path.resolve(__dirname, 'adv.pdf');
  try { fs.unlinkSync(fakePath); } catch {}
  require.cache[pdfSvcPath] = { exports: { gerarAdvertenciaPdfEIndexar: async (args) => {
    pdfArgs = args;
    fs.writeFileSync(fakePath, args.clausulas.map(c => `${c.numero}: ${c.texto}`).join('\n'));
    return { filePath: fakePath, token: 'TOK1' };
  } } };

  const authPath = path.resolve(__dirname, '../src/middleware/adminAuthMiddleware.js');
  require.cache[authPath] = { exports: (_req,_res,next)=>next() };

  const logs = [];
  const origLog = console.log;
  console.log = (msg, ...args) => { logs.push(typeof msg === 'string' ? msg : String(msg)); origLog.call(console, msg, ...args); };

  delete require.cache[require.resolve('../src/api/adminAdvertenciasRoutes.js')];
  const routes = require('../src/api/adminAdvertenciasRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', routes);

    const clausulasPayload = [
      { numero: '5.22', texto: 'Cláusula 5.22 texto' },
      { numero: '7.3', texto: 'Cláusula 7.3 texto' }
    ];
    const payload = {
      fatos: 'F',
      clausulas: clausulasPayload,
      multa: 50,
      gera_multa: true,
      inapto: false,
      prazo_recurso: '2030-01-01'
    };
    const res = await supertest(app).post('/api/admin/eventos/10/advertencias').send(payload).expect(201);
    assert.ok(res.body.id);
    assert.equal(res.body.token, 'TOK1');

    const row = await get('SELECT multa, gera_multa, inapto, clausulas FROM advertencias WHERE id=?', [res.body.id]);
    assert.equal(row.multa, 50);
    assert.equal(row.gera_multa, 1);
    assert.equal(row.inapto, 0);
    const saved = JSON.parse(row.clausulas);
    assert.deepEqual(saved, clausulasPayload);

    assert.ok(pdfArgs.clausulas.some(c => c.texto === clausulasPayload[1].texto));
    const pdfContent = fs.readFileSync(fakePath, 'utf8');
    assert.ok(pdfContent.includes(clausulasPayload[1].texto));


  assert.ok(logs.some(l => l.includes('gerar DAR')));
  assert.equal(mailSent, true);
  console.log = origLog;
});

test('PUT resolver respeita prazo e zera sancoes', async () => {
  const dbPath = path.resolve(__dirname, 'test-advertencia-recurso.db');
  const { run, get } = prepDb(dbPath);

  await run(`CREATE TABLE advertencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER,
    fatos TEXT,
    clausulas TEXT,
    multa REAL,
    gera_multa INTEGER,
    inapto INTEGER,
    prazo_recurso TEXT,
    status TEXT,
    token TEXT,
    pdf_url TEXT,
    pdf_public_url TEXT,
    created_at TEXT,
    resolved_at TEXT,
    outcome TEXT
  )`);

  const future = new Date(Date.now()+86400000).toISOString();
  const past = new Date(Date.now()-86400000).toISOString();
  await run(`INSERT INTO advertencias (id, evento_id, fatos, clausulas, multa, gera_multa, inapto, prazo_recurso, status) VALUES (1, 10, 'F', '[]', 100, 1, 1, ?, 'emitida')`, [future]);
  await run(`INSERT INTO advertencias (id, evento_id, fatos, clausulas, multa, gera_multa, inapto, prazo_recurso, status) VALUES (2, 10, 'F', '[]', 100, 1, 1, ?, 'emitida')`, [past]);

  const authPath = path.resolve(__dirname, '../src/middleware/adminAuthMiddleware.js');
  require.cache[authPath] = { exports: (_req,_res,next)=>next() };
  delete require.cache[require.resolve('../src/api/adminAdvertenciasRoutes.js')];
  const routes = require('../src/api/adminAdvertenciasRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', routes);

  await supertest(app).put('/api/admin/advertencias/1/resolver').send({ resultado: 'aceito' }).expect(200);
  const okRow = await get('SELECT status, multa, inapto FROM advertencias WHERE id=1');
  assert.equal(okRow.status, 'recurso_aceito');
  assert.equal(okRow.multa, 0);
  assert.equal(okRow.inapto, 0);

  await supertest(app).put('/api/admin/advertencias/2/resolver').send({ resultado: 'aceito' }).expect(400);
  const lateRow = await get('SELECT status, multa, inapto FROM advertencias WHERE id=2');
  assert.equal(lateRow.status, 'emitida');
  assert.equal(lateRow.multa, 100);
  assert.equal(lateRow.inapto, 1);
});

test('GET /api/documentos/verify/:token retorna metadados', async () => {
  const dbPath = path.resolve(__dirname, 'test-advertencia-token.db');
  const { run } = prepDb(dbPath);

  await run(`CREATE TABLE documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT,
    token TEXT,
    evento_id INTEGER,
    pdf_public_url TEXT,
    created_at TEXT,
    status TEXT
  )`);

  await run(`INSERT INTO documentos (tipo, token, evento_id, pdf_public_url, created_at, status) VALUES ('advertencia','TOK-VER',10,'/documentos/adv.pdf', datetime('now'), 'gerado')`);
  const assinafyPath = path.resolve(__dirname, '../src/services/assinafyClient.js');
  require.cache[assinafyPath] = { exports: { uploadPdf: async () => {}, getDocumentStatus: async () => ({}), downloadSignedPdf: async () => Buffer.from('') } };
  const documentosRoutes = require('../src/api/documentosRoutes.js');
  const app = express();
  app.use('/api/documentos', documentosRoutes);

  const res = await supertest(app).get('/api/documentos/verify/TOK-VER').expect(200);
  assert.equal(res.body.valid, true);
  assert.equal(res.body.tipo, 'advertencia');
  assert.equal(res.body.tipo_titulo, 'Advertência');
  assert.equal(res.body.pdf_public_url, '/documentos/adv.pdf');
  assert.equal(res.body.status, 'gerado');
  assert.ok(res.body.created_at);
  assert.equal(res.body.authentic, false);
  assert.equal(res.body.message, 'Documento encontrado, porém o arquivo PDF não está disponível');
  assert.ok(!('token' in res.body));
});

