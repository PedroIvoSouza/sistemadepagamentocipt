const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

async function setup(dataVencimento) {
  const dbPath = path.resolve(__dirname, `certidao-${Math.random()}.db`);
  try { fs.unlinkSync(dbPath); } catch {}
  process.env.SQLITE_STORAGE = dbPath;

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbModulePath];
  const db = require('../src/database/db');

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, email TEXT, tipo TEXT);`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, data_vencimento TEXT, status TEXT, sem_juros INTEGER DEFAULT 0);`);
  await run(`CREATE TABLE documentos (id INTEGER PRIMARY KEY, tipo TEXT, caminho TEXT, token TEXT);`);

  await run(`INSERT INTO permissionarios (id, nome_empresa, cnpj, email) VALUES (1, 'Perm', '12345678000199', 'perm@example.com');`);
  await run(`INSERT INTO dars (id, permissionario_id, data_vencimento, status) VALUES (1, 1, ?, 'Pendente');`, [dataVencimento]);

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id: 1 }; next(); } };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = { exports: { gerarTokenDocumento: async () => 'TKN' } };

  const permRoutesPath = path.resolve(__dirname, '../src/api/permissionariosRoutes.js');
  delete require.cache[permRoutesPath];
  const permissionariosRoutes = require('../src/api/permissionariosRoutes');

  const app = express();
  app.use('/api/permissionarios', permissionariosRoutes);

  const origWrite = fs.writeFileSync;
  const origMkdir = fs.mkdirSync;
  fs.writeFileSync = () => {};
  fs.mkdirSync = () => {};

  async function cleanup() {
    fs.writeFileSync = origWrite;
    fs.mkdirSync = origMkdir;
    db.close();
    delete require.cache[dbModulePath];
    delete require.cache[authPath];
    delete require.cache[tokenPath];
    delete require.cache[permRoutesPath];
    try { fs.unlinkSync(dbPath); } catch {}
  }

  return { app, cleanup };
}

test('certidao generation only blocked by overdue unpaid DARs', async (t) => {
  await t.test('future DAR does not block', async () => {
    const { app, cleanup } = await setup('2030-01-01');
    await supertest(app).get('/api/permissionarios/1/certidao').expect(200);
    await cleanup();
  });

  await t.test('overdue DAR blocks', async () => {
    const { app, cleanup } = await setup('2020-01-01');
    const res = await supertest(app).get('/api/permissionarios/1/certidao').expect(422);
    assert.ok(res.body.error.toLowerCase().includes('pendências financeiras'));
    await cleanup();
  });
});

