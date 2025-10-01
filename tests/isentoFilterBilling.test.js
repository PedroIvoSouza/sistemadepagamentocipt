const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sqlite3 = require('sqlite3').verbose();

test('dashboard and pagamentos ignore isentos ou valor zero', async () => {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, err => err?rej(err):res()));

  await run(`CREATE TABLE permissionarios (id INTEGER PRIMARY KEY, nome_empresa TEXT, cnpj TEXT, tipo TEXT, valor_aluguel REAL);`);
  await run(`CREATE TABLE dars (id INTEGER PRIMARY KEY, permissionario_id INTEGER, tipo_permissionario TEXT, valor REAL, data_vencimento TEXT, status TEXT, mes_referencia INTEGER, ano_referencia INTEGER, sem_juros INTEGER DEFAULT 0);`);

  await run(`INSERT INTO permissionarios (id,nome_empresa,cnpj,tipo,valor_aluguel) VALUES (1,'Normal','1','Normal',100);`);
  await run(`INSERT INTO permissionarios (id,nome_empresa,cnpj,tipo,valor_aluguel) VALUES (2,'Isento','2','Isento',100);`);
  await run(`INSERT INTO permissionarios (id,nome_empresa,cnpj,tipo,valor_aluguel) VALUES (3,'Zero','3','Normal',0);`);

  await run(`INSERT INTO dars (permissionario_id,tipo_permissionario,valor,data_vencimento,status,mes_referencia,ano_referencia) VALUES (1,'Permissionario',100,'2030-01-01','Pendente',1,2030);`);
  await run(`INSERT INTO dars (permissionario_id,tipo_permissionario,valor,data_vencimento,status,mes_referencia,ano_referencia) VALUES (2,'Permissionario',100,'2030-01-01','Pendente',1,2030);`);
  await run(`INSERT INTO dars (permissionario_id,tipo_permissionario,valor,data_vencimento,status,mes_referencia,ano_referencia) VALUES (3,'Permissionario',100,'2030-01-01','Pendente',1,2030);`);

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  require.cache[dbModulePath] = { exports: db };
  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = { exports: (req,_res,next) => { req.user = { id:1 }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  require.cache[rolePath] = { exports: () => (_req,_res,next) => next() };

  const adminRoutes = require('../src/api/adminRoutes');
  const app = express();
  app.use('/api/admin', adminRoutes);
  const request = supertest(app);

  const dash = await request.get('/api/admin/dashboard-stats').expect(200);
  assert.equal(dash.body.darsPendentes, 1);

  const rel = await request.get('/api/admin/relatorios/pagamentos?mes=1&ano=2030').expect(200);
  assert.equal(rel.body.devedores.length, 1);
  assert.equal(rel.body.devedores[0].permissionario_id, 1);

  db.close();
  delete require.cache[dbModulePath];
  delete require.cache[authPath];
  delete require.cache[rolePath];
});
