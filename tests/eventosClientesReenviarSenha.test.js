const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');
const supertest = require('supertest');

test('POST /:id/reenviar-senha envia email', async () => {
  const adminAuthPath = path.resolve(__dirname, '../src/middleware/adminAuthMiddleware.js');
  const adminAuthOrig = require.cache[adminAuthPath];
  require.cache[adminAuthPath] = { exports: (_req, _res, next) => next() };

  const emailPath = path.resolve(__dirname, '../src/services/emailService.js');
  const emailOrig = require.cache[emailPath];
  let emailArgs;
  require.cache[emailPath] = {
    exports: {
      enviarEmailDefinirSenha: async (...args) => {
        emailArgs = args;
        return true;
      }
    }
  };

  const sqlite3Path = require.resolve('sqlite3');
  const sqlite3Orig = require.cache[sqlite3Path];
  const future = Date.now() + 3600 * 1000;
  require.cache[sqlite3Path] = {
    exports: {
      verbose: () => ({
        Database: class {
          get(_sql, _params, cb) {
            cb(null, {
              email: 'c@x.com',
              nome_razao_social: 'Cliente',
              token_definir_senha: 'TOK1',
              token_definir_senha_expires: future
            });
          }
          run(_sql, _params, cb) { cb && cb.call({ changes: 1 }, null); }
          all() {}
        }
      })
    }
  };

  const assinafyPath = path.resolve(__dirname, '../src/services/assinafyClient.js');
  const assinafyOrig = require.cache[assinafyPath];
  require.cache[assinafyPath] = { exports: { uploadPdf: async () => {} } };

  const termoPath = path.resolve(__dirname, '../src/services/termoEventoPdfkitService.js');
  const termoOrig = require.cache[termoPath];
  require.cache[termoPath] = { exports: { gerarTermoEventoPdfkitEIndexar: async () => {} } };

  delete require.cache[require.resolve('../src/api/eventosClientesRoutes.js')];
  const routes = require('../src/api/eventosClientesRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/', routes.adminRoutes);

  const res = await supertest(app).post('/1/reenviar-senha').expect(200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(emailArgs, ['c@x.com', 'Cliente', 'TOK1']);

  require.cache[adminAuthPath] = adminAuthOrig;
  require.cache[emailPath] = emailOrig;
  require.cache[sqlite3Path] = sqlite3Orig;
  require.cache[assinafyPath] = assinafyOrig;
  require.cache[termoPath] = termoOrig;
});

