const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function setup(events) {
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
  const sqlitePath = require.resolve('sqlite3');
  require.cache[sqlitePath] = { exports: sqlite3Stub };

  const letterheadPath = path.resolve(__dirname, '../src/utils/pdfLetterhead.js');
  require.cache[letterheadPath] = { exports: { applyLetterhead: () => () => {}, abntMargins: () => ({ top:50, bottom:50, left:50, right:50 }) } };

  delete require.cache[require.resolve('../src/services/termoEventoPdfkitService.js')];
  return require('../src/services/termoEventoPdfkitService.js');
}

test('gera PDF com espaco_utilizado em JSON', async () => {
  const events = {
    1: {
      id: 1,
      numero_processo: '1',
      numero_termo: 'T1',
      nome_razao_social: 'Empresa',
      documento: '123',
      endereco: 'Rua X',
      cep: '00000-000',
      nome_responsavel: 'Joao',
      documento_responsavel: '321',
      datas_evento: '["2025-01-01"]',
      hora_inicio: '10h',
      hora_fim: '11h',
      area_m2: 100,
      total_diarias: 1,
      valor_final: 1000,
      espaco_utilizado: '["Auditório","Sala de Reunião 1"]',
      nome_evento: 'Evento'
    }
  };
  const { gerarTermoEventoPdfkitEIndexar } = setup(events);
  const { filePath } = await gerarTermoEventoPdfkitEIndexar(1);
  const pdfParse = require('pdf-parse');
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  assert.match(parsed.text, /Auditório, Sala de Reunião 1/);
  await fs.promises.unlink(filePath);
});

test('inclui cláusulas 1.2 e 5.21 quando há empréstimo de equipamentos', async () => {
  const events = {
    3: {
      id: 3,
      numero_processo: '3',
      numero_termo: 'T3',
      nome_razao_social: 'Empresa',
      documento: '123',
      endereco: 'Rua Z',
      cep: '00000-000',
      nome_responsavel: 'Carlos',
      documento_responsavel: '987',
      datas_evento: '2025-03-03',
      hora_inicio: '08h',
      hora_fim: '18h',
      area_m2: 60,
      total_diarias: 1,
      valor_final: 800,
      espaco_utilizado: 'Auditório',
      nome_evento: 'Evento3',
      emprestimo_tvs: 1,
      emprestimo_caixas_som: 1,
      emprestimo_microfones: 1
    }
  };
  const { gerarTermoEventoPdfkitEIndexar } = setup(events);
  const { filePath } = await gerarTermoEventoPdfkitEIndexar(3);
  const pdfParse = require('pdf-parse');
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  assert.match(parsed.text, /1\.2 - [\s\S]*TVs, caixas de som e microfones/);
  assert.match(parsed.text, /5\.21 - Caso haja danos ou furtos aos equipamentos emprestados, a PERMISSIONÁRIA deverá arcar/);
  await fs.promises.unlink(filePath);
});

test('gera PDF com espaco_utilizado em CSV', async () => {
  const events = {
    2: {
      id: 2,
      numero_processo: '2',
      numero_termo: 'T2',
      nome_razao_social: 'Empresa',
      documento: '123',
      endereco: 'Rua Y',
      cep: '00000-000',
      nome_responsavel: 'Maria',
      documento_responsavel: '654',
      datas_evento: '2025-02-02',
      hora_inicio: '09h',
      hora_fim: '10h',
      area_m2: 80,
      total_diarias: 1,
      valor_final: 500,
      espaco_utilizado: 'Auditório,Sala de Reunião 2',
      nome_evento: 'Evento2'
    }
  };
  const { gerarTermoEventoPdfkitEIndexar } = setup(events);
  const { filePath } = await gerarTermoEventoPdfkitEIndexar(2);
  const pdfParse = require('pdf-parse');
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  assert.match(parsed.text, /Auditório, Sala de Reunião 2/);
  await fs.promises.unlink(filePath);
});

