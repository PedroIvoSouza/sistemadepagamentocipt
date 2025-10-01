const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');
const sqlite3 = require('sqlite3').verbose();
const { Sequelize } = require('sequelize');

const migration = require('../src/migrations/20250926120000-fix-dars-eventos-foreign-key');

const runSql = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

test('migration keeps DARs_Eventos triggers and emitir route works', async () => {
  const dbPath = path.resolve(__dirname, 'migration-dars-eventos.db');
  try {
    fs.unlinkSync(dbPath);
  } catch {}

  process.env.SQLITE_STORAGE = dbPath;
  process.env.COD_IBGE_MUNICIPIO = '2704302';
  process.env.RECEITA_CODIGO_PERMISSIONARIO = '12345';

  const db = new sqlite3.Database(dbPath);

  await runSql(
    db,
    `CREATE TABLE Eventos_old (
      id INTEGER PRIMARY KEY,
      descricao TEXT
    );`
  );

  await runSql(
    db,
    `CREATE TABLE Eventos (
      id INTEGER PRIMARY KEY,
      descricao TEXT
    );`
  );

  await runSql(
    db,
    `CREATE TABLE permissionarios (
      id INTEGER PRIMARY KEY,
      nome_empresa TEXT,
      cnpj TEXT,
      tipo TEXT
    );`
  );

  await runSql(
    db,
    `CREATE TABLE dars (
      id INTEGER PRIMARY KEY,
      permissionario_id INTEGER,
      data_vencimento TEXT,
      mes_referencia INTEGER,
      ano_referencia INTEGER,
      valor REAL,
      status TEXT,
      numero_documento TEXT,
      pdf_url TEXT,
      linha_digitavel TEXT,
      codigo_barras TEXT,
      link_pdf TEXT,
      emitido_por_id INTEGER,
      data_emissao TEXT,
      advertencia_fatos TEXT,
      sem_juros INTEGER DEFAULT 0
    );`
  );

  await runSql(
    db,
    `CREATE TABLE DARs_Eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      id_dar INTEGER,
      numero_parcela INTEGER,
      valor_parcela REAL,
      data_vencimento TEXT,
      FOREIGN KEY (id_evento) REFERENCES Eventos_old(id),
      FOREIGN KEY (id_dar) REFERENCES dars(id)
    );`
  );

  await runSql(db, `CREATE INDEX idx_dars_eventos_evento ON DARs_Eventos(id_evento);`);

  await runSql(
    db,
    `CREATE TRIGGER trg_dars_evento_orfa
     AFTER DELETE ON DARs_Eventos
     BEGIN
       UPDATE dars SET status = 'Orfao' WHERE id = OLD.id_dar;
     END;`
  );

  await runSql(db, `INSERT INTO Eventos_old (id, descricao) VALUES (1, 'Evento antigo');`);
  await runSql(db, `INSERT INTO Eventos (id, descricao) VALUES (1, 'Evento atual');`);
  await runSql(
    db,
    `INSERT INTO permissionarios (id, nome_empresa, cnpj, tipo)
     VALUES (1, 'Empresa Teste', '12345678000199', 'Permissionario');`
  );
  await runSql(
    db,
    `INSERT INTO dars (id, permissionario_id, data_vencimento, mes_referencia, ano_referencia, valor, status)
     VALUES (1, 1, '2030-01-15', 1, 2030, 150.5, 'Novo');`
  );
  await runSql(
    db,
    `INSERT INTO DARs_Eventos (id_evento, id_dar, numero_parcela, valor_parcela, data_vencimento)
     VALUES (1, 1, 1, 150.5, '2030-01-15');`
  );

  await new Promise((resolve, reject) => db.close(err => (err ? reject(err) : resolve())));

  const sequelize = new Sequelize({ dialect: 'sqlite', storage: dbPath, logging: false });
  const queryInterface = sequelize.getQueryInterface();
  await migration.up(queryInterface);

  const [pragmaResult] = await sequelize.query(`PRAGMA trigger_list('DARs_Eventos');`);
  const pragmaTriggers = Array.isArray(pragmaResult)
    ? pragmaResult
    : pragmaResult
      ? [pragmaResult]
      : [];
  const pragmaNames = pragmaTriggers
    .map(trigger => trigger && trigger.name)
    .filter(Boolean)
    .map(name => String(name));

  let hasTrigger = pragmaNames.includes('trg_dars_evento_orfa');

  if (!hasTrigger) {
    const [masterRows] = await sequelize.query(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='DARs_Eventos';`
    );
    const masterList = Array.isArray(masterRows) ? masterRows : masterRows ? [masterRows] : [];
    hasTrigger = masterList.some(row => row && row.name === 'trg_dars_evento_orfa');
  }

  assert.ok(
    hasTrigger,
    'trg_dars_evento_orfa should exist after migration'
  );

  await sequelize.close();

  const dbModulePath = path.resolve(__dirname, '../src/database/db.js');
  delete require.cache[dbModulePath];

  const sefazPath = path.resolve(__dirname, '../src/services/sefazService.js');
  require.cache[sefazPath] = {
    exports: {
      emitirGuiaSefaz: async () => ({ numeroGuia: '999', pdfBase64: 'PDFDATA' })
    }
  };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  require.cache[tokenPath] = {
    exports: {
      gerarTokenDocumento: async () => 'TOKEN',
      imprimirTokenEmPdf: async pdf => pdf
    }
  };

  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  require.cache[authPath] = {
    exports: (req, _res, next) => {
      req.user = { id: 1 };
      next();
    }
  };

  const cobrancaPath = path.resolve(__dirname, '../src/services/cobrancaService.js');
  require.cache[cobrancaPath] = {
    exports: {
      calcularEncargosAtraso: async dar => ({
        valorAtualizado: dar.valor,
        novaDataVencimento: dar.data_vencimento
      })
    }
  };

  const darsRoutesPath = path.resolve(__dirname, '../src/api/darsRoutes.js');
  delete require.cache[darsRoutesPath];
  const darsRoutes = require(darsRoutesPath);

  const app = express();
  app.use(express.json());
  app.use('/api/dars', darsRoutes);

  await supertest(app).post('/api/dars/1/emitir').send({}).expect(200);
});

