// tests/adminDarsRoutesCreate.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');
const { isoHojeLocal } = require('../src/utils/sefazPayload');

async function setupContext(name, permissionarios = [], options = {}) {
  const opts = options || {};
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
  const emitirGuiaSefazMock =
    opts.emitirGuiaSefaz ||
    (async () => {
      throw new Error('SEFAZ não deve ser chamado nos testes de criação de DAR.');
    });
  require.cache[sefazPath] = {
    exports: {
      emitirGuiaSefaz: emitirGuiaSefazMock,
      consultarPagamentoPorCodigoBarras: async () => null,
      listarPagamentosPorDataArrecadacao: async () => []
    }
  };

  const cobrancaPath = path.resolve(__dirname, '../src/services/cobrancaService.js');
  delete require.cache[cobrancaPath];
  const cobrancaCalls = [];
  const calcularEncargosDelegate = opts.calcularEncargosAtraso;
  require.cache[cobrancaPath] = {
    exports: {
      calcularEncargosAtraso: async (...args) => {
        cobrancaCalls.push(args);
        if (typeof calcularEncargosDelegate === 'function') {
          return calcularEncargosDelegate(...args);
        }
        return null;
      }
    }
  };

  const tokenPath = path.resolve(__dirname, '../src/utils/token.js');
  delete require.cache[tokenPath];
  const tokenCalls = [];
  require.cache[tokenPath] = {
    exports: {
      imprimirTokenEmPdf: async (pdfBase64, token) => {
        tokenCalls.push([pdfBase64, token]);
        return pdfBase64;
      }
    }
  };

  const db = require('../src/database/db');
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

  await run(`CREATE TABLE permissionarios (
    id INTEGER PRIMARY KEY,
    nome_empresa TEXT,
    cnpj TEXT,
    cpf TEXT,
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
    numero_documento TEXT,
    pdf_url TEXT,
    linha_digitavel TEXT,
    codigo_barras TEXT,
    data_emissao TEXT,
    emitido_por_id INTEGER,
    advertencia_fatos TEXT,
    sem_juros INTEGER DEFAULT 0
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
    delete require.cache[cobrancaPath];
    delete require.cache[tokenPath];
    if (previousDbPath === undefined) {
      delete process.env.SQLITE_STORAGE;
    } else {
      process.env.SQLITE_STORAGE = previousDbPath;
    }
    try { fs.unlinkSync(dbFile); } catch {}
  }

  return { request, get, run, cleanup, notifCalls, whatsappCalls, cobrancaCalls, tokenCalls };
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
    assert.equal(res.body.dar.sem_juros, 0);

    const row = await ctx.get('SELECT * FROM dars WHERE id = ?', [res.body.dar.id]);
    assert.equal(row.tipo_permissionario, 'Permissionario');
    assert.equal(row.valor, 150);
    assert.equal(row.data_vencimento, '2024-02-29');
    assert.equal(row.mes_referencia, 2);
    assert.equal(row.ano_referencia, 2024);
    assert.equal(row.advertencia_fatos, null);
    assert.equal(row.sem_juros, 0);

    assert.equal(ctx.notifCalls.length, 1);
    assert.equal(ctx.notifCalls[0][2]?.tipo, 'novo');
    assert.equal(ctx.whatsappCalls.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/admin/dars cria mensalidade sem juros com vencimento hoje', async () => {
  const ctx = await setupContext('mensal-sem-juros', [
    {
      id: 1,
      nome_empresa: 'Empresa Sem Juros',
      valor_aluguel: 180,
      tipo: null,
      telefone: '82911112223'
    }
  ]);

  try {
    const res = await ctx.request
      .post('/api/admin/dars')
      .send({ permissionarioId: 1, tipo: 'Mensalidade', competencia: '2024-05', semJuros: true })
      .expect(201);

    const hoje = isoHojeLocal();
    assert.equal(res.body.dar.data_vencimento, hoje);
    assert.equal(res.body.dar.sem_juros, 1);

    const row = await ctx.get('SELECT * FROM dars WHERE id = ?', [res.body.dar.id]);
    assert.equal(row.data_vencimento, hoje);
    assert.equal(row.sem_juros, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/admin/dars sobrescreve mensalidade existente sem juros', async () => {
  const ctx = await setupContext('mensal-sobrescreve', [
    {
      id: 10,
      nome_empresa: 'Empresa Override',
      valor_aluguel: 220,
      tipo: null,
      telefone: '82922223333'
    }
  ]);

  try {
    const primeiraResposta = await ctx.request
      .post('/api/admin/dars')
      .send({ permissionarioId: 10, tipo: 'Mensalidade', competencia: '2024-06' })
      .expect(201);

    const darIdOriginal = primeiraResposta.body?.dar?.id;
    assert.ok(darIdOriginal, 'DAR inicial não criado');

    const segundaResposta = await ctx.request
      .post('/api/admin/dars')
      .send({ permissionarioId: 10, tipo: 'Mensalidade', competencia: '2024-06', semJuros: true })
      .expect(200);

    const hoje = isoHojeLocal();
    assert.equal(segundaResposta.body?.dar?.id, darIdOriginal);
    assert.equal(segundaResposta.body?.dar?.data_vencimento, hoje);
    assert.equal(segundaResposta.body?.dar?.sem_juros, 1);

    const row = await ctx.get('SELECT * FROM dars WHERE id = ?', [darIdOriginal]);
    assert.equal(row.data_vencimento, hoje);
    assert.equal(row.sem_juros, 1);
    assert.equal(row.status, 'Pendente');

    const count = await ctx.get('SELECT COUNT(*) AS total FROM dars');
    assert.equal(count.total, 1);
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

test('POST /api/admin/dars/:id/emitir respeita sem juros e ajusta vencimento para hoje', async () => {
  const ctx = await setupContext(
    'emitir-sem-juros',
    [
      {
        id: 9,
        nome_empresa: 'Empresa Emitir',
        valor_aluguel: 200,
        tipo: null,
        telefone: '82911114444',
        cnpj: '12345678000199'
      }
    ],
    {
      emitirGuiaSefaz: async () => ({
        numeroGuia: '202400123',
        pdfBase64: Buffer.from('PDF').toString('base64'),
        linhaDigitavel: '001',
        codigoBarras: '002'
      }),
      calcularEncargosAtraso: async () => {
        throw new Error('calcularEncargosAtraso não deve ser chamado');
      }
    }
  );

  try {
    await ctx.run(
      `INSERT INTO dars (id, permissionario_id, tipo_permissionario, valor, data_vencimento, status, mes_referencia, ano_referencia, advertencia_fatos, sem_juros)
       VALUES (42, 9, 'Permissionario', 200, '2024-01-10', 'Pendente', 1, 2024, NULL, 1)`
    );

    const res = await ctx.request.post('/api/admin/dars/42/emitir').send({}).expect(200);

    const hoje = isoHojeLocal();
    assert.equal(res.body.ok, true);
    assert.equal(res.body.numero, '202400123');
    assert.equal(ctx.cobrancaCalls.length, 0);

    const row = await ctx.get('SELECT * FROM dars WHERE id = ?', [42]);
    assert.equal(row.data_vencimento, hoje);
    assert.equal(row.sem_juros, 1);
    assert.equal(row.mes_referencia, 1);
    assert.equal(row.ano_referencia, 2024);
    assert.ok(ctx.tokenCalls.length > 0);
    assert.deepEqual(ctx.tokenCalls[0], [Buffer.from('PDF').toString('base64'), 'DAR-202400123']);
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
