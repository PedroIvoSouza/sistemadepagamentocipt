const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

async function setupDatabase(tempName) {
  const dbFile = path.resolve(__dirname, `test-dars-baixa-${tempName}.db`);
  try { fs.unlinkSync(dbFile); } catch {}
  const previous = process.env.SQLITE_STORAGE;
  process.env.SQLITE_STORAGE = dbFile;

  const dbPath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbPath];
  const db = require('../src/database/db');

  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
  await run(`CREATE TABLE permissionarios (
    id INTEGER PRIMARY KEY,
    nome_empresa TEXT,
    cnpj TEXT,
    email TEXT
  )`);
  await run(`CREATE TABLE dars (
    id INTEGER PRIMARY KEY,
    permissionario_id INTEGER,
    valor REAL,
    data_vencimento TEXT,
    status TEXT,
    mes_referencia INTEGER,
    ano_referencia INTEGER,
    data_pagamento TEXT,
    comprovante_token TEXT
  )`);
  await run(`CREATE TABLE documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT,
    caminho TEXT,
    permissionario_id INTEGER,
    evento_id INTEGER,
    pdf_url TEXT,
    pdf_public_url TEXT,
    status TEXT,
    created_at TEXT
  )`);
  await run(`CREATE TABLE administradores (
    id INTEGER PRIMARY KEY,
    nome TEXT,
    email TEXT,
    role TEXT
  )`);

  process.env.SQLITE_STORAGE = dbFile;
  return { db, run, restore: () => { process.env.SQLITE_STORAGE = previous; } };
}

function stubModule(modulePath, exportsObject) {
  const resolved = path.resolve(__dirname, modulePath);
  delete require.cache[resolved];
  require.cache[resolved] = { exports: exportsObject };
}

test('permissionário solicita baixa manual e admin aprova', async () => {
  const { db, run, restore } = await setupDatabase('flow');
  const originalFs = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    existsSync: fs.existsSync,
    unlinkSync: fs.unlinkSync,
  };
  const mkdirCalls = [];
  const writeCalls = [];
  const unlinkCalls = [];
  fs.mkdirSync = (...args) => { mkdirCalls.push(args); };
  fs.writeFileSync = (...args) => { writeCalls.push(args); };
  fs.existsSync = () => true;
  fs.unlinkSync = (...args) => { unlinkCalls.push(args); };

  try {
    await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj, email) VALUES (1, 'Empresa Teste', '12345678000190', 'teste@exemplo.com')`);
    await run(`INSERT INTO administradores (id, nome, email, role) VALUES (10, 'Admin', 'admin@exemplo.com', 'SUPER_ADMIN')`);
    await run(`INSERT INTO dars (id, permissionario_id, valor, data_vencimento, status, mes_referencia, ano_referencia) VALUES (5, 1, 500.0, '2025-10-01', 'Pendente', 9, 2025)`);

    const authPath = '../src/middleware/authMiddleware.js';
    const rolePath = '../src/middleware/roleMiddleware.js';
    stubModule(authPath, (req, _res, next) => { req.user = { id: 1 }; next(); });

    const sefazPath = '../src/services/sefazService.js';
    stubModule(sefazPath, {
      emitirGuiaSefaz: async () => { throw new Error('não utilizado nos testes'); },
      consultarPagamentoPorCodigoBarras: async () => null,
      listarPagamentosPorDataArrecadacao: async () => [],
    });

    const darsRoutesPath = path.resolve(__dirname, '../src/api/darsRoutes.js');
    delete require.cache[darsRoutesPath];
    const darsRoutes = require('../src/api/darsRoutes');
    const permApp = express();
    permApp.use(express.json());
    permApp.use('/api/dars', darsRoutes);
    const permRequest = supertest(permApp);

    const respostaPerm = await permRequest
      .post('/api/dars/5/solicitacoes-baixa')
      .set('Authorization', 'Bearer token')
      .field('dataPagamento', '2025-10-02')
      .attach('guia', Buffer.from('%PDF-1.4 guia'), 'guia.pdf')
      .attach('comprovante', Buffer.from('%PDF-1.4 comp'), 'comprovante.pdf')
      .expect(201);

    assert.equal(respostaPerm.body.ok, true);
    assert.ok(respostaPerm.body.solicitacao_id);

    // now switch auth middleware for admin context
    stubModule(authPath, (req, _res, next) => { req.user = { id: 10, role: 'SUPER_ADMIN' }; next(); });
    stubModule(rolePath, () => (_req, _res, next) => next());

    const adminRoutesPath = path.resolve(__dirname, '../src/api/adminDarsRoutes.js');
    delete require.cache[adminRoutesPath];
    const adminDarsRoutes = require('../src/api/adminDarsRoutes');
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use('/api/admin/dars', adminDarsRoutes);
    const adminRequest = supertest(adminApp);

    const listaResp = await adminRequest
      .get('/api/admin/dars/baixa-solicitacoes?status=pendente')
      .set('Authorization', 'Bearer token')
      .expect(200);

    assert.ok(Array.isArray(listaResp.body.solicitacoes));
    assert.equal(listaResp.body.solicitacoes.length, 1);
    const solicitacaoId = listaResp.body.solicitacoes[0].id;
    assert.equal(listaResp.body.solicitacoes[0].status, 'pendente');

    const aprovarResp = await adminRequest
      .post(`/api/admin/dars/baixa-solicitacoes/${solicitacaoId}/aprovar`)
      .set('Authorization', 'Bearer token')
      .send({ dataPagamento: '2025-10-03', observacao: 'Pagto validado' })
      .expect(200);

    assert.equal(aprovarResp.body.ok, true);
    assert.equal(aprovarResp.body.solicitacao.status, 'aprovado');

    const darAtualizado = await new Promise((resolve, reject) =>
      db.get('SELECT status, data_pagamento FROM dars WHERE id = 5', [], (err, row) => (err ? reject(err) : resolve(row)))
    );
    assert.equal(darAtualizado.status, 'Pago');
    assert.equal(String(darAtualizado.data_pagamento).slice(0, 10), '2025-10-03');

    assert.ok(mkdirCalls.length > 0);
    assert.ok(writeCalls.length > 0);
  } finally {
    fs.mkdirSync = originalFs.mkdirSync;
    fs.writeFileSync = originalFs.writeFileSync;
    fs.existsSync = originalFs.existsSync;
    fs.unlinkSync = originalFs.unlinkSync;
    db.close();
    restore();
  }
});

