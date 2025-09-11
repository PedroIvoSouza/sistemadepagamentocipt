const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const supertest = require('supertest');

// Regression test for caching signed_pdf_public_url

test('GET /api/portal/eventos/:id/termo/meta caches signed url', async () => {
  // create fake pdf file
  const pdfPath = path.resolve(__dirname, 'fake.pdf');
  fs.writeFileSync(pdfPath, 'pdf');

  // mock sqlite3 to keep documentos row in memory
  const sqlite3Path = require.resolve('sqlite3');
  const sqlite3Orig = require.cache[sqlite3Path];
  class FakeDB {
    constructor() {
      this.doc = {
        id: 1,
        evento_id: 1,
        tipo: 'termo_evento',
        pdf_url: pdfPath,
        pdf_public_url: 'public.pdf',
        assinafy_id: 'ASS1',
        signed_pdf_public_url: null,
        status: 'pendente',
      };
    }
    get(_sql, _params, cb) { cb(null, this.doc); }
    all(_sql, _params, cb) { cb(null, []); }
    run(sql, params, cb) {
      if (sql.includes('signed_pdf_public_url')) {
        this.doc.signed_pdf_public_url = params[0];
      }
      cb && cb.call({ changes: 1 }, null);
    }
  }
  require.cache[sqlite3Path] = {
    exports: { verbose: () => ({ Database: FakeDB }) }
  };

  // mock assinafy service
  const assinafyPath = path.resolve(__dirname, '../src/services/assinafyService.js');
  const assinafyOrig = require.cache[assinafyPath];
  let calls = 0;
  require.cache[assinafyPath] = {
    exports: {
      getDocument: async () => {
        calls++;
        return { data: { artifacts: { certified: 'https://signed.example.com/file.pdf' }, status: 'signed' } };
      },
      pickBestArtifactUrl: (doc) => doc.data.artifacts.certified,
    }
  };

  // mock auth and role middlewares
  const authPath = path.resolve(__dirname, '../src/middleware/authMiddleware.js');
  const authOrig = require.cache[authPath];
  require.cache[authPath] = { exports: (req, _res, next) => { req.user = { id:1, role:'CLIENTE_EVENTO' }; next(); } };
  const rolePath = path.resolve(__dirname, '../src/middleware/roleMiddleware.js');
  const roleOrig = require.cache[rolePath];
  require.cache[rolePath] = { exports: () => (_req,_res,next)=>next() };

  // mock assinafy client and termo service to avoid env dependencies
  const assinafyClientPath = path.resolve(__dirname, '../src/services/assinafyClient.js');
  const assinafyClientOrig = require.cache[assinafyClientPath];
  require.cache[assinafyClientPath] = { exports: { uploadPdf: async () => {} } };
  const termoServicePath = path.resolve(__dirname, '../src/services/termoEventoPdfkitService.js');
  const termoServiceOrig = require.cache[termoServicePath];
  require.cache[termoServicePath] = { exports: { gerarTermoEventoPdfkitEIndexar: async () => {} } };
  const sefazServicePath = path.resolve(__dirname, '../src/services/sefazService.js');
  const sefazServiceOrig = require.cache[sefazServicePath];
  require.cache[sefazServicePath] = { exports: { emitirGuiaSefaz: async () => {} } };

  // load routes with mocks
  delete require.cache[require.resolve('../src/api/eventosClientesRoutes.js')];
  const routes = require('../src/api/eventosClientesRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/portal/eventos', routes.clientRoutes);
  const request = supertest(app);

  // first call: should call getDocument and store URL
  await request
    .get('/api/portal/eventos/1/termo/meta')
    .expect(200)
    .expect(res => {
      assert.equal(res.body.signed_pdf_public_url, 'https://signed.example.com/file.pdf');
    });
  assert.equal(calls, 1);

  // second call: should reuse stored URL without new getDocument call
  await request
    .get('/api/portal/eventos/1/termo/meta')
    .expect(200)
    .expect(res => {
      assert.equal(res.body.signed_pdf_public_url, 'https://signed.example.com/file.pdf');
    });
  assert.equal(calls, 1);

  // cleanup
  fs.unlinkSync(pdfPath);
  require.cache[sqlite3Path] = sqlite3Orig;
  require.cache[assinafyPath] = assinafyOrig;
  require.cache[authPath] = authOrig;
  require.cache[rolePath] = roleOrig;
  require.cache[assinafyClientPath] = assinafyClientOrig;
  require.cache[termoServicePath] = termoServiceOrig;
  require.cache[sefazServicePath] = sefazServiceOrig;
});

