// tests/adminDarsRoutesCreate.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

async function setupContext(name, permissionarios = []) {
  const dbFile = path.resolve(__dirname, `test-admin-dars-create-${name}.db`);
  try { fs.unlinkSync(dbFile); } catch {}
  const previousDbPath = process.env.SQLITE_STORAGE;
  process.env.SQLITE_STORAGE = dbFile;

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbModulePath];

  const notifPath = path.resolve(__dirname, '../src/services/notificacaoService.js');
  delete require.cache[notifPath];
  const notifCalls = [];
  require.cache[notifPath] = {
    exports: {
      notificarDarGerado: async (...args) => {
        notifCalls.push(args);
        return true;
      }
    }
  };

  const whatsappPath = path.resolve(__dirname, '../src/services/whatsappService.js');
  delete require.cache[whatsappPath];
  const whatsappCalls = [];
  require.cache[whatsappPath] = {
    exports: {
      sendMessage: async (...args) => {
        whatsappCalls.push(args);
        return true;
      }
    }
  };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  delete require.cache[authPath];
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  delete require.cache[rolePath];
  require.cache[rolePath] = { exports: () => (_req, _res, next) => next() };

  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  delete require.cache[sefazPath];
  require.cache[sefazPath] = {
    exports: {
      emitirGuiaSefaz: async () => {
        throw new Error('SEFAZ não deve ser chamado nos testes de criação de DAR.');
      },
      consultarPagamentoPorCodigoBarras: async () => null,
      listarPagamentosPorDataArrecadacao: async () => []
    }
  };

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

  await run(`CREATE TABLE permissionarios (
    id INTEGER PRIMARY KEY,
    nome_empresa TEXT,
    valor_aluguel REAL,
    tipo TEXT,
    telefone TEXT,
    telefone_cobranca TEXT,
    email TEXT,
    email_notificacao TEXT,
    email_financeiro TEXT
  )`);

  await run(`CREATE TABLE dars (
    id INTEGER PRIMARY KEY,
    permissionario_id INTEGER,
    tipo_permissionario TEXT,
    valor REAL,
    data_vencimento TEXT,
    status TEXT,
    mes_referencia INTEGER,
    ano_referencia INTEGER,
    advertencia_fatos TEXT
  )`);

  for (const perm of permissionarios) {
    const columns = Object.keys(perm);
    const placeholders = columns.map(() => '?').join(',');
    await run(
      `INSERT INTO permissionarios (${columns.join(',')}) VALUES (${placeholders})`,
      columns.map((c) => perm[c])
    );
  }

  const adminPath = path.resolve(__dirname, '../src/api/adminDarsRoutes.js');
  delete require.cache[adminPath];
  const adminDarsRoutes = require('../src/api/adminDarsRoutes');

  const app = express();
  app.use(express.json());
  app.use('/api/admin/dars', adminDarsRoutes);
  const request = supertest(app);

  async function cleanup() {
    await new Promise((resolve) => db.close(() => resolve()));
    delete require.cache[adminPath];
    delete require.cache[notifPath];
    delete require.cache[whatsappPath];
    delete require.cache[authPath];
    delete require.cache[rolePath];
    delete require.cache[dbModulePath];
    delete require.cache[sefazPath];
    if (previousDbPath === undefined) {
      delete process.env.SQLITE_STORAGE;
    } else {
      process.env.SQLITE_STORAGE = previousDbPath;
    }
    try { fs.unlinkSync(dbFile); } catch {}
  }

  return { request, get, run, cleanup, notifCalls, whatsappCalls };
}

test('POST /api/admin/dars cria mensalidade com último dia útil', async () => {
  const ctx = await setupContext('mensal', [
    {
      id: 1,
      nome_empresa: 'Empresa Teste',
      valor_aluguel: 150,
      tipo: null,
      telefone: '82911112222',
      telefone_cobranca: '82999998888',
      email: 'teste@empresa.com'
    }
  ]);

  try {
    const res = await ctx.request
      .post('/api/admin/dars')
      .send({ permissionarioId: 1, tipo: 'Mensalidade', competencia: '2024-02' })
      .expect(201);

    assert.ok(res.body?.dar);
    assert.equal(res.body.dar.permissionario_id, 1);
    assert.equal(res.body.dar.valor, 150);
    assert.equal(res.body.dar.data_vencimento, '2024-02-29');
    assert.equal(res.body.dar.status, 'Pendente');
    assert.equal(res.body.dar.mes_referencia, 2);
    assert.equal(res.body.dar.ano_referencia, 2024);

    const row = await ctx.get('SELECT * FROM dars WHERE id = ?', [res.body.dar.id]);
    assert.equal(row.tipo_permissionario, 'Permissionario');
    assert.equal(row.valor, 150);
    assert.equal(row.data_vencimento, '2024-02-29');
    assert.equal(row.mes_referencia, 2);
    assert.equal(row.ano_referencia, 2024);
    assert.equal(row.advertencia_fatos, null);

    assert.equal(ctx.notifCalls.length, 1);
    assert.equal(ctx.notifCalls[0][2]?.tipo, 'novo');
    assert.equal(ctx.whatsappCalls.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/admin/dars rejeita mensalidade para permissionário isento ou sem aluguel', async () => {
  const ctx = await setupContext('mensal-invalido', [
    {
      id: 1,
      nome_empresa: 'Isento',
      valor_aluguel: 0,
      tipo: 'Isento',
      telefone: '82911112222'
    }
  ]);

  try {
    const res = await ctx.request
      .post('/api/admin/dars')
      .send({ permissionarioId: 1, tipo: 'Mensalidade', competencia: '2024-03' })
      .expect(400);

    assert.match(res.body.error, /isento|aluguel/i);
    assert.equal(ctx.notifCalls.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/admin/dars cria DAR de advertência validando dia útil', async () => {
  const ctx = await setupContext('advertencia', [
    {
      id: 5,
      nome_empresa: 'Empresa Advertida',
      valor_aluguel: 200,
      tipo: null,
      telefone: '82911113333',
      email: 'contato@empresa.com'
    }
  ]);

  try {
    const res = await ctx.request
      .post('/api/admin/dars')
      .send({
        permissionarioId: 5,
        tipo: 'Advertencia',
        competencia: '03/2024',
        dataPagamento: '2024-03-18',
        valor: '250.50',
        fatos: ['Descumprimento de normas', 'Uso indevido do espaço']
      })
      .expect(201);

    assert.ok(res.body?.dar);
    assert.equal(res.body.dar.tipo_permissionario, 'Advertencia');
    assert.equal(res.body.dar.valor, 250.5);
    assert.equal(res.body.dar.data_vencimento, '2024-03-18');
    assert.equal(res.body.dar.mes_referencia, 3);
    assert.equal(res.body.dar.ano_referencia, 2024);
    assert.ok(res.body.dar.advertencia_fatos.includes('Descumprimento'));

    const row = await ctx.get('SELECT * FROM dars WHERE id = ?', [res.body.dar.id]);
    assert.equal(row.tipo_permissionario, 'Advertencia');
    assert.equal(row.advertencia_fatos.split('\n').length, 2);

    assert.equal(ctx.notifCalls.length, 1);
    assert.equal(ctx.notifCalls[0][2]?.tipo, 'advertencia');
    assert.deepEqual(ctx.notifCalls[0][2]?.fatos, ['Descumprimento de normas', 'Uso indevido do espaço']);
    assert.equal(ctx.whatsappCalls.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/admin/dars rejeita advertência em final de semana', async () => {
  const ctx = await setupContext('advertencia-weekend', [
    {
      id: 7,
      nome_empresa: 'Empresa Weekend',
      valor_aluguel: 100,
      tipo: null,
      telefone: '82911114444'
    }
  ]);

  try {
    await ctx.request
      .post('/api/admin/dars')
      .send({
        permissionarioId: 7,
        tipo: 'Advertencia',
        dataPagamento: '2024-03-17',
        valor: 120,
        fatos: 'Incidente'
      })
      .expect(400);

    assert.equal(ctx.notifCalls.length, 0);
  } finally {
    await ctx.cleanup();
  }
});
