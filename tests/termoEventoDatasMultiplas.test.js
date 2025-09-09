const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const realSqlite3 = require('sqlite3');
const sqlitePath = require.resolve('sqlite3');

function setupPdf(events) {
  class FakeDB {
    get(sql, params, cb) {
      if (/FROM Eventos/.test(sql)) {
        cb(null, events[params[0]]);
      } else {
        cb(null, undefined);
      }
    }
    all(sql, params, cb) {
      cb(null, []);
    }
    run(sql, params, cb) {
      cb.call({}, null);
    }
  }
  const sqlite3Stub = { verbose: () => sqlite3Stub, Database: FakeDB };
  require.cache[sqlitePath] = { exports: sqlite3Stub };

  const letterheadPath = path.resolve(__dirname, '../src/utils/pdfLetterhead.js');
  require.cache[letterheadPath] = {
    exports: { applyLetterhead: () => () => {}, abntMargins: () => ({ top:50, bottom:50, left:50, right:50 }) }
  };

  delete require.cache[require.resolve('../src/services/termoEventoPdfkitService.js')];
  const svc = require('../src/services/termoEventoPdfkitService.js');
  require.cache[sqlitePath] = { exports: realSqlite3 };
  return svc;
}

function setupExport(events) {
  class FakeDB {
    get(sql, params, cb) {
      if (/FROM Eventos/.test(sql)) {
        cb(null, events[params[0]]);
      } else {
        cb(null, undefined);
      }
    }
    all(sql, params, cb) {
      cb(null, []);
    }
  }
  const sqlite3Stub = { verbose: () => sqlite3Stub, Database: FakeDB };
  require.cache[sqlitePath] = { exports: sqlite3Stub };

  delete require.cache[require.resolve('../src/services/termoEventoExportService.js')];
  const svc = require('../src/services/termoEventoExportService.js');
  require.cache[sqlitePath] = { exports: realSqlite3 };
  return svc;
}

test('pdfkit service uses range and separate montagem/desmontagem for multiple dates', async () => {
  const events = {
    1: {
      id: 1,
      numero_processo: '3',
      numero_termo: 'T3',
      nome_razao_social: 'Empresa',
      documento: '123',
      endereco: 'Rua Z',
      nome_responsavel: 'Ana',
      documento_responsavel: '789',
      datas_evento: '["2025-01-01","2025-01-03"]',
      hora_inicio: '10h',
      hora_fim: '11h',
      area_m2: 50,
      total_diarias: 2,
      valor_final: 200,
      espaco_utilizado: '["Auditório"]',
      nome_evento: 'Evento'
    }
  };
  const { gerarTermoEventoPdfkitEIndexar } = setupPdf(events);
  const { filePath } = await gerarTermoEventoPdfkitEIndexar(1);
  const pdfParse = require('pdf-parse');
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  assert.match(parsed.text, /01 de janeiro de 2025 a 03 de janeiro de 2025/);
  assert.match(parsed.text, /03 de janeiro de 2025/);
  await fs.promises.unlink(filePath);
});

test('export service payload builds correct period and montagem/desmontagem', async () => {
  const events = {
    2: {
      id: 2,
      numero_processo: '4',
      numero_termo: 'T4',
      nome_razao_social: 'Empresa',
      documento: '123',
      endereco: 'Rua Q',
      nome_responsavel: 'Jose',
      documento_responsavel: '456',
      datas_evento: '2025-02-01,2025-02-05',
      hora_inicio: '08h',
      hora_fim: '12h',
      area_m2: 80,
      total_diarias: 5,
      valor_final: 500,
      espaco_utilizado: 'Auditório',
      nome_evento: 'Evento2'
    }
  };
  const { buildPayloadFromEvento } = setupExport(events);
  const payload = await buildPayloadFromEvento(2);
  assert.equal(payload.data_evento, '01 de fevereiro de 2025 a 05 de fevereiro de 2025');
  assert.equal(payload.data_montagem, '01 de fevereiro de 2025');
  assert.equal(payload.data_desmontagem, '05 de fevereiro de 2025');
});
