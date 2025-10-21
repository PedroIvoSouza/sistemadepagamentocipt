// cron/conciliarPagamentosmes.js  (rotina DIÁRIA 06:00 America/Maceio)
// - Concilia 1 dia por vez (ontem por padrão)
// - Reemissão com juros: chave exata (guia/barras/linha) resolve sem tolerância ampla
// - Sem guia: prioriza referência (ano/mes) + evita vencimento futuro + tie-break por vencimento

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const {
  SQLITE_STORAGE,
  CONCILIACAO_TOLERANCIA_CENTAVOS = '500',
  DEBUG_CONCILIACAO = 'true',
  CONCILIAR_BASE_DIA = 'ontem', // "ontem" (padrão) ou "hoje"
} = process.env;

const DB_PATH = path.resolve(SQLITE_STORAGE || '/home/pedroivodesouza/sistemadepagamentocipt/sistemacipt.db');

const TOL_BASE = Number(CONCILIACAO_TOLERANCIA_CENTAVOS) || 500;
const DBG = String(DEBUG_CONCILIACAO).toLowerCase() === 'true';
const dlog = (...a) => { if (DBG) console.log('[DEBUG]', ...a); };

console.log(`BUILD: conciliarPagamentosmes.js(daily) @ ${new Date().toISOString()} | TOL_BASE=${TOL_BASE}¢ | DEBUG=${DBG}`);

const {
  listarPagamentosPorDataArrecadacao,
  listarPagamentosPorDataInclusao,
} = require('../src/services/sefazService');

// ------------------------- Helpers -------------------------
function normalizeDoc(s = '') { return String(s).replace(/\D/g, ''); }
function cents(n) { return Math.round(Number(n || 0) * 100); }
function isCNPJ(s = '') { return /^\d{14}$/.test(normalizeDoc(s)); }
function cnpjRoot(s = '') { return normalizeDoc(s).slice(0, 8); }
function SQL_NORM(col) { return `REPLACE(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),'/',''),' ','')`; }
function ymd(d) { const off = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return off.toISOString().slice(0,10); }
function toDateTimeString(date, hh, mm, ss) {
  const yyyy = date.getFullYear();
  const MM   = String(date.getMonth()+1).padStart(2,'0');
  const dd   = String(date.getDate()).padStart(2,'0');
  const HH   = String(hh).padStart(2,'0');
  const mi   = String(mm).padStart(2,'0');
  const ss_  = String(ss).padStart(2,'0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mi}:${ss_}`;
}
function endsWithSufixoGuia(numDoc, guiaNum, minLen = 6) {
  const a = normalizeDoc(numDoc || ''); const b = normalizeDoc(guiaNum || '');
  if (!a || !b) return false;
  const sfx = b.slice(-Math.min(minLen, b.length));
  return a.endsWith(sfx);
}

// ------------------------- DB -------------------------
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[CONCILIA] Erro ao conectar ao banco de dados:', err.message);
    process.exit(1);
  }
});
const dbAll = (sql,p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r||[])));
const dbRun = (sql,p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){ if(e) return rej(e); res(this); }));
const dbGet = (sql,p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));

let conciliaTableEnsured = false;
let conciliaDetalheTableEnsured = false;

async function ensureConciliacaoLogTable() {
  if (conciliaTableEnsured) return;
  try {
    const row = await dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dar_conciliacoes' LIMIT 1"
    );
    if (!row || !row.name) {
      await dbRun(
        `CREATE TABLE IF NOT EXISTS dar_conciliacoes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data_execucao TEXT NOT NULL,
          data_referencia TEXT NOT NULL,
          iniciou_em TEXT,
          finalizou_em TEXT,
          duracao_ms INTEGER,
          total_pagamentos INTEGER DEFAULT 0,
          total_atualizados INTEGER DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'sucesso' CHECK(status IN ('sucesso','falha')),
          mensagem TEXT
        )`
      );
      await dbRun('CREATE INDEX IF NOT EXISTS idx_dar_conciliacoes_data_ref ON dar_conciliacoes(data_referencia)');
      await dbRun('CREATE INDEX IF NOT EXISTS idx_dar_conciliacoes_execucao ON dar_conciliacoes(data_execucao DESC)');
    }
  } catch (err) {
    console.error('[CONCILIA] Falha ao garantir tabela de conciliações:', err?.message || err);
  } finally {
    conciliaTableEnsured = true;
  }
}

async function ensureConciliacaoDetalhesTable() {
  if (conciliaDetalheTableEnsured) return;
  try {
    const row = await dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dar_conciliacoes_pagamentos' LIMIT 1"
    );
    if (!row || !row.name) {
      await dbRun(
        `CREATE TABLE IF NOT EXISTS dar_conciliacoes_pagamentos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conciliacao_id INTEGER NOT NULL,
          dar_id INTEGER,
          status_anterior TEXT,
          status_atual TEXT,
          numero_documento TEXT,
          valor REAL,
          data_vencimento TEXT,
          data_pagamento TEXT,
          origem TEXT,
          contribuinte TEXT,
          documento_contribuinte TEXT,
          pagamento_guia TEXT,
          pagamento_documento TEXT,
          pagamento_valor REAL,
          pagamento_data TEXT,
          criado_em TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (conciliacao_id) REFERENCES dar_conciliacoes(id) ON DELETE CASCADE
        )`
      );
      await dbRun(
        'CREATE INDEX IF NOT EXISTS idx_dar_conc_pag_conciliacao ON dar_conciliacoes_pagamentos(conciliacao_id)'
      );
      await dbRun('CREATE INDEX IF NOT EXISTS idx_dar_conc_pag_dar ON dar_conciliacoes_pagamentos(dar_id)');
    }
  } catch (err) {
    console.error('[CONCILIA] Falha ao garantir tabela de detalhes da conciliação:', err?.message || err);
  } finally {
    conciliaDetalheTableEnsured = true;
  }
}

async function registrarConciliacaoLog(entry) {
  try {
    await ensureConciliacaoLogTable();
    const agora = new Date().toISOString();
    const dataReferencia = entry?.dataReferencia || null;
    const iniciouEm = entry?.iniciouEm || null;
    const finalizouEm = entry?.finalizouEm || null;
    const duracaoMs = Number.isFinite(entry?.duracaoMs) ? Math.max(0, Math.round(entry.duracaoMs)) : null;
    const totalPagamentos = Number.isFinite(entry?.totalPagamentos)
      ? entry.totalPagamentos
      : Number(entry?.totalPagamentos || 0);
    const totalAtualizados = Number.isFinite(entry?.totalAtualizados)
      ? entry.totalAtualizados
      : Number(entry?.totalAtualizados || 0);
    const status = entry?.sucesso === false ? 'falha' : 'sucesso';
    const mensagem = entry?.mensagem ? String(entry.mensagem).slice(0, 500) : null;

    const insert = await dbRun(
      `INSERT INTO dar_conciliacoes (
        data_execucao,
        data_referencia,
        iniciou_em,
        finalizou_em,
        duracao_ms,
        total_pagamentos,
        total_atualizados,
        status,
        mensagem
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agora,
        dataReferencia,
        iniciouEm,
        finalizouEm,
        duracaoMs,
        totalPagamentos,
        totalAtualizados,
        status,
        mensagem,
      ]
    );

    const conciliacaoId = insert?.lastID || insert?.lastId || insert?.id || null;
    const detalhes = Array.isArray(entry?.pagamentosDetalhes) ? entry.pagamentosDetalhes : [];

    if (conciliacaoId && detalhes.length) {
      await ensureConciliacaoDetalhesTable();
      for (const detalhe of detalhes) {
        try {
          await dbRun(
            `INSERT INTO dar_conciliacoes_pagamentos (
              conciliacao_id,
              dar_id,
              status_anterior,
              status_atual,
              numero_documento,
              valor,
              data_vencimento,
              data_pagamento,
              origem,
              contribuinte,
              documento_contribuinte,
              pagamento_guia,
              pagamento_documento,
              pagamento_valor,
              pagamento_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              conciliacaoId,
              detalhe?.darId || null,
              detalhe?.statusAnterior || null,
              detalhe?.statusAtual || null,
              detalhe?.numeroDocumento || null,
              detalhe?.valor != null ? Number(detalhe.valor) : null,
              detalhe?.dataVencimento || null,
              detalhe?.dataPagamento || null,
              detalhe?.origem || null,
              detalhe?.contribuinte || null,
              detalhe?.documentoContribuinte || null,
              detalhe?.pagamento?.guia || null,
              detalhe?.pagamento?.documento || null,
              detalhe?.pagamento?.valor != null ? Number(detalhe.pagamento.valor) : null,
              detalhe?.pagamento?.data || null,
            ]
          );
        } catch (err) {
          console.error('[CONCILIA] Falha ao registrar detalhe de conciliação:', err?.message || err);
        }
      }
    }
  } catch (err) {
    console.error('[CONCILIA] Não foi possível registrar log da conciliação:', err?.message || err);
  }
}

// ------------------------- Tie-breakers -------------------------
async function applyTiebreakers(cands, guiaNum, dtPgto) {
  let list = (cands || []).slice();

  // 1) Sufixo da guia (se houver)
  if (guiaNum) {
    const bySfx = list.filter(r => endsWithSufixoGuia(r.numero_documento, guiaNum, 6));
    if (bySfx.length === 1) return bySfx[0];
    if (bySfx.length > 1) list = bySfx;
  }

  // 2) Priorizar referência mais antiga (mês/ano)
  list.sort((a,b) => {
    const ka = (a.ano_referencia ?? 9999) * 100 + (a.mes_referencia ?? 99);
    const kb = (b.ano_referencia ?? 9999) * 100 + (b.mes_referencia ?? 99);
    return ka - kb;
  });

  // 3) Dentro da mesma referência, preferir vencimento mais próximo ao pagamento
  if (dtPgto) {
    const base = new Date(String(dtPgto).slice(0,10));
    list.sort((a,b) => {
      const ka = (a.ano_referencia ?? 9999) * 100 + (a.mes_referencia ?? 99);
      const kb = (b.ano_referencia ?? 9999) * 100 + (b.mes_referencia ?? 99);
      if (ka !== kb) return ka - kb;
      const da = new Date(a.data_vencimento || '1970-01-01');
      const db = new Date(b.data_vencimento || '1970-01-01');
      return Math.abs(da - base) - Math.abs(db - base);
    });
  }

  return list[0] || null;
}

async function rankAndTry(rows, tolList, ctxLabel, dtPgto, guiaNum, pagoCents, marcarFn) {
  rows = rows || [];
  dlog(`${ctxLabel}: candidatos pré-tolerância = ${rows.length}`);
  for (const tol of tolList) {
    const candTol = rows.filter((r) => Math.abs(Math.round(r.valor * 100) - pagoCents) <= tol);
    dlog(`${ctxLabel}: tol=${tol}¢ → ${candTol.length} candidato(s)`);
    if (candTol.length === 1) {
      const resultado = await marcarFn(candTol[0], ctxLabel, dtPgto);
      if (resultado?.vinculado) {
        return { done: true, resultado };
      }
    } else if (candTol.length > 1) {
      const picked = await applyTiebreakers(candTol, guiaNum, dtPgto);
      if (picked) {
        const resultado = await marcarFn(picked, ctxLabel, dtPgto);
        if (resultado?.vinculado) {
          dlog(`${ctxLabel}: resolveu via tie-breakers (ref/vencimento): id=${picked.id}`);
          return { done: true, resultado };
        }
      }
      dlog(
        `${ctxLabel}: Ambíguo (${candTol.length}). Exemplos:`,
        candTol.slice(0, 3).map((x) => ({ id: x.id, valor: x.valor, numero_documento: x.numero_documento }))
      );
      return { done: false, multi: true };
    }
  }
  return { done: false };
}

async function obterResumoDarParaLog(darId) {
  if (!darId) return null;
  const dar = await dbGet(
    `SELECT id, numero_documento, valor, data_vencimento, data_pagamento, status, permissionario_id
       FROM dars
      WHERE id = ?
      LIMIT 1`,
    [darId]
  ).catch(() => null);

  if (!dar) return null;

  let origem = null;
  let contribuinte = null;
  let documentoContribuinte = null;

  if (dar.permissionario_id) {
    origem = 'permissionario';
    const perm = await dbGet(
      `SELECT nome_empresa, cnpj, cpf FROM permissionarios WHERE id = ? LIMIT 1`,
      [dar.permissionario_id]
    ).catch(() => null);
    contribuinte = perm?.nome_empresa || null;
    const doc = String(perm?.cnpj || perm?.cpf || '').trim();
    documentoContribuinte = doc || null;
  } else {
    origem = 'evento';
    const ev = await dbGet(
      `SELECT e.nome_evento, ce.nome_razao_social, ce.documento, ce.documento_responsavel
         FROM DARs_Eventos de
         JOIN Eventos e ON e.id = de.id_evento
         JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
        WHERE de.id_dar = ?
        LIMIT 1`,
      [darId]
    ).catch(() => null);
    contribuinte = ev?.nome_evento || ev?.nome_razao_social || null;
    const docEv = String(ev?.documento || ev?.documento_responsavel || '').trim();
    documentoContribuinte = docEv || null;
  }

  return {
    darId,
    numero_documento: dar.numero_documento || null,
    valor: dar.valor != null ? Number(dar.valor) : null,
    data_vencimento: dar.data_vencimento || null,
    data_pagamento: dar.data_pagamento || null,
    status: dar.status || null,
    origem,
    contribuinte,
    documento_contribuinte: documentoContribuinte,
  };
}

// ------------------------- Vinculação -------------------------
async function tentarVincularPagamento(pagamento) {
  const {
    numeroDocOrigem = '',
    numeroGuia = '',
    codigoBarras = '',
    linhaDigitavel = '',
    dataPagamento,
    valorPago = 0,
    numeroInscricao = '',
  } = pagamento;

  const guiaNum = numeroGuia || '';
  const docPagador = normalizeDoc(numeroInscricao || '');
  const pagoCents = cents(valorPago);

  const pagamentoResumo = {
    guia: numeroGuia || codigoBarras || linhaDigitavel || null,
    documento: numeroInscricao || null,
    valor: valorPago != null ? Number(valorPago) : null,
    data: dataPagamento || null,
  };

  const anexarPagamento = (resultado) => {
    if (resultado && resultado.vinculado) {
      resultado.pagamento = pagamentoResumo;
    }
    return resultado;
  };

  async function marcarDar(row, via) {
    if (!row || !row.id) return { vinculado: false };
    const statusAnterior = row.status || null;
    const statusLower = String(statusAnterior || '').toLowerCase();
    if (statusLower.startsWith('pago')) {
      return anexarPagamento({ vinculado: true, atualizado: false, darId: row.id, via, statusAnterior });
    }

    const update = await dbRun(
      `UPDATE dars SET status='Pago', data_pagamento=COALESCE(?, data_pagamento) WHERE id=? AND status!='Pago'`,
      [dataPagamento || null, row.id]
    );

    if (update?.changes > 0) {
      return anexarPagamento({ vinculado: true, atualizado: true, darId: row.id, via, statusAnterior });
    }

    const after = await dbGet(`SELECT status FROM dars WHERE id = ?`, [row.id]).catch(() => null);
    if (String(after?.status || '').toLowerCase().startsWith('pago')) {
      return anexarPagamento({ vinculado: true, atualizado: false, darId: row.id, via, statusAnterior });
    }

    return { vinculado: false };
  }

  async function marcarPorSelect(selectSql, params, via) {
    const row = await dbGet(selectSql, params).catch(() => null);
    if (!row || !row.id) return null;
    return marcarDar(row, via);
  }

  // Tolerância: só 2¢ quando houver chave exata; ampla quando NÃO houver.
  const hasChaveExata = !!(numeroGuia || codigoBarras || linhaDigitavel);
  const tolList = hasChaveExata
    ? [2]
    : [2, TOL_BASE, Math.max(TOL_BASE, Math.round(pagoCents * 0.03))];

  // 0) Tentativas diretas (chaves exatas)
  if (numeroDocOrigem) {
    const res = await marcarPorSelect('SELECT id, status FROM dars WHERE id = ? LIMIT 1', [numeroDocOrigem], 'direto:id');
    if (res?.vinculado) return res;
  }
  if (codigoBarras) {
    const res = await marcarPorSelect('SELECT id, status FROM dars WHERE codigo_barras = ? LIMIT 1', [codigoBarras], 'direto:codigo_barras');
    if (res?.vinculado) return res;
  }
  if (linhaDigitavel) {
    const res = await marcarPorSelect('SELECT id, status FROM dars WHERE linha_digitavel = ? LIMIT 1', [linhaDigitavel], 'direto:linha_digitavel');
    if (res?.vinculado) return res;
  }
  if (guiaNum) {
    const res = await marcarPorSelect('SELECT id, status FROM dars WHERE numero_documento = ? LIMIT 1', [guiaNum], 'direto:numero_documento');
    if (res?.vinculado) return res;
  }

  // 0.2) Equivalências normalizadas
  if (codigoBarras) {
    const cbNorm = normalizeDoc(codigoBarras);
    if (cbNorm) {
      const res = await marcarPorSelect(
        `SELECT id, status FROM dars WHERE ${SQL_NORM('codigo_barras')} = ? LIMIT 1`,
        [cbNorm],
        'direto:codigo_barras_norm'
      );
      if (res?.vinculado) return res;
    }
  }
  if (linhaDigitavel) {
    const ldNorm = normalizeDoc(linhaDigitavel);
    if (ldNorm) {
      const res = await marcarPorSelect(
        `SELECT id, status FROM dars WHERE ${SQL_NORM('linha_digitavel')} = ? LIMIT 1`,
        [ldNorm],
        'direto:linha_digitavel_norm'
      );
      if (res?.vinculado) return res;
    }
  }
  if (guiaNum) {
    const res = await marcarPorSelect(
      `SELECT id, status FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) LIMIT 1`,
      [guiaNum],
      'direto:numero_documento_num'
    );
    if (res?.vinculado) return res;
  }

  if (!(valorPago > 0)) return { vinculado: false };

  // Data base para vetar vencimento futuro
  const dataBase = dataPagamento || ymd(new Date());

  const marcarRankFn = async (candidate, ctxLabel) => {
    if (!candidate || !candidate.id) return { vinculado: false };
    return marcarDar({ id: candidate.id, status: candidate.status }, `rank:${ctxLabel}`);
  };

  // 1) Permissionário (CNPJ exato/raiz) + tolerância
  let permIds = [];
  if (isCNPJ(docPagador)) {
    const permExato = await dbGet(`SELECT id FROM permissionarios WHERE ${SQL_NORM('cnpj')} = ? LIMIT 1`, [docPagador]);
    if (permExato?.id) permIds = [permExato.id];
    if (permIds.length === 0) {
      const raiz = cnpjRoot(docPagador);
      const permRaiz = await dbAll(`SELECT id FROM permissionarios WHERE substr(${SQL_NORM('cnpj')},1,8) = ?`, [raiz]);
      if (permRaiz.length === 1) permIds = [permRaiz[0].id];
      else if (permRaiz.length > 1) permIds = permRaiz.map((r) => r.id);
    }
  }
  if (permIds.length > 0) {
    const placeholders = permIds.map(() => '?').join(',');
    const candPerm = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
              d.mes_referencia, d.ano_referencia, d.status
         FROM dars d
        WHERE d.permissionario_id IN (${placeholders})
          AND d.status != 'Pago'
          AND date(d.data_vencimento) <= date(?)
        ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
                 ABS(ROUND(d.valor*100) - ?) ASC,
                 d.data_vencimento ASC
        LIMIT 50`,
      [...permIds, dataBase, cents(valorPago)]
    );
    const r = await rankAndTry(candPerm, tolList, 'perm', dataPagamento, guiaNum, cents(valorPago), marcarRankFn);
    if (r?.resultado?.vinculado) return r.resultado;
    if (r?.multi) return { vinculado: false };
  }

  // 2) Eventos (doc cliente exato/raiz) + tolerância
  const candEv = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
            d.mes_referencia, d.ano_referencia, d.status
       FROM dars d
       JOIN DARs_Eventos de ON de.id_dar = d.id
       JOIN Eventos e       ON e.id = de.id_evento
       JOIN Clientes_Eventos ce ON ce.id = e.id_cliente
      WHERE (
            ${SQL_NORM('ce.documento')} = ?
        OR  (length(${SQL_NORM('ce.documento')})=14 AND substr(${SQL_NORM('ce.documento')},1,8) = ?)
      )
        AND d.status != 'Pago'
        AND date(d.data_vencimento) <= date(?)
      ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
               ABS(ROUND(d.valor*100) - ?) ASC,
               d.data_vencimento ASC
      LIMIT 50`,
    [normalizeDoc(numeroInscricao || ''), isCNPJ(numeroInscricao || '') ? cnpjRoot(numeroInscricao) : '__NO_ROOT__', dataBase, cents(valorPago)]
  );
  const rEvento = await rankAndTry(candEv, tolList, 'evento', dataPagamento, guiaNum, cents(valorPago), marcarRankFn);
  if (rEvento?.resultado?.vinculado) return rEvento.resultado;
  if (rEvento?.multi) return { vinculado: false };

  // 3) Guia + valor (mesmo número, sem depender do valor exato)
  if (guiaNum) {
    const candGuia = await dbAll(
      `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
              d.mes_referencia, d.ano_referencia, d.status
         FROM dars d
        WHERE CAST(${SQL_NORM('d.numero_documento')} AS INTEGER) = CAST(? AS INTEGER)
          AND d.status != 'Pago'
          AND date(d.data_vencimento) <= date(?)
        ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
                 ABS(ROUND(d.valor*100) - ?) ASC,
                 d.data_vencimento ASC
        LIMIT 50`,
      [guiaNum, dataBase, cents(valorPago)]
    );
    const rGuia = await rankAndTry(candGuia, tolList, 'guia+valor', dataPagamento, guiaNum, cents(valorPago), marcarRankFn);
    if (rGuia?.resultado?.vinculado) return rGuia.resultado;
    if (rGuia?.multi) return { vinculado: false };
  }

  // 4) LIKE sufixo da guia + valor
  if (guiaNum) {
    const sfx = normalizeDoc(guiaNum).slice(-6);
    if (sfx) {
      const candLike = await dbAll(
        `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
                d.mes_referencia, d.ano_referencia, d.status
           FROM dars d
          WHERE ${SQL_NORM('d.numero_documento')} LIKE '%' || ?
            AND d.status != 'Pago'
            AND date(d.data_vencimento) <= date(?)
          ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
                   ABS(ROUND(d.valor*100) - ?) ASC,
                   d.data_vencimento ASC
          LIMIT 50`,
        [sfx, dataBase, cents(valorPago)]
      );
      const rLike = await rankAndTry(candLike, tolList, 'likeGuia+valor', dataPagamento, guiaNum, cents(valorPago), marcarRankFn);
      if (rLike?.resultado?.vinculado) return rLike.resultado;
      if (rLike?.multi) return { vinculado: false };
    }
  }

  // 5) Janela de vencimento ±60d + valor (último recurso)
  const baseDt = dataPagamento ? String(dataPagamento).slice(0, 10) : ymd(new Date());
  const maxTol = Math.max(TOL_BASE, Math.round(cents(valorPago) * 0.03));
  const candJan = await dbAll(
    `SELECT d.id, d.valor, d.numero_documento, d.data_vencimento,
            d.mes_referencia, d.ano_referencia, d.status
       FROM dars d
      WHERE d.status != 'Pago'
        AND ABS(ROUND(d.valor*100) - ?) <= ?
        AND ABS(julianday(d.data_vencimento) - julianday(?)) <= 60
        AND date(d.data_vencimento) <= date(?)
      ORDER BY d.ano_referencia ASC, d.mes_referencia ASC,
               ABS(ROUND(d.valor*100) - ?) ASC,
               d.data_vencimento ASC
      LIMIT 50`,
    [cents(valorPago), maxTol, baseDt, dataBase, cents(valorPago)]
  );
  dlog(`janela±60d: candidatos = ${candJan.length}`);
  if (candJan.length === 1) {
    const res = await marcarDar({ id: candJan[0].id, status: candJan[0].status }, 'janela±60d');
    if (res?.vinculado) return res;
  } else if (candJan.length > 1) {
    const picked = await applyTiebreakers(candJan, guiaNum, dataPagamento);
    if (picked) {
      const res = await marcarDar({ id: picked.id, status: picked.status }, 'janela±60d');
      if (res?.vinculado) return res;
    }
  }

  if (guiaNum) {
    const existe = await dbGet(
      `SELECT 1 AS ok FROM dars WHERE CAST(${SQL_NORM('numero_documento')} AS INTEGER) = CAST(? AS INTEGER) LIMIT 1`,
      [guiaNum]
    );
    if (!existe?.ok) console.warn(`[MOTIVO] DAR inexistente no banco para guia=${guiaNum}. Verifique se foi emitida/importada.`);
  }
  return { vinculado: false };
}

// ------------------------- Core diário -------------------------
async function conciliarPagamentosDoDia(dataISO) {
  const dataDia = dataISO || ymd(new Date());
  console.log(`[CONCILIA] Iniciando conciliação do dia ${dataDia}... DB=${DB_PATH}`);

  const inicioMs = Date.now();
  const dia = new Date(`${dataDia}T00:00:00`);
  const dtHoraInicioDia = toDateTimeString(dia, 0, 0, 0);
  const dtHoraFimDia = toDateTimeString(dia, 23, 59, 59);

  const pagamentosMap = new Map();
  let resumo = { dataDia, totalPagamentos: 0, totalAtualizados: 0, pagamentosAtualizados: [] };
  let sucesso = false;
  let mensagemErro = null;

  try {
    try {
      // Arrecadação (dia fechado)
      const pagsArr = await listarPagamentosPorDataArrecadacao(dataDia, dataDia);
      for (const p of pagsArr) {
        const key =
          p.numeroGuia ||
          p.codigoBarras ||
          p.linhaDigitavel ||
          `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) {
      console.warn(`[CONCILIA] Aviso por-data-arrecadacao(${dataDia}): ${e.message || e}`);
    }

    try {
      // Inclusão (janela 00:00:00~23:59:59)
      const pagsInc = await listarPagamentosPorDataInclusao(dtHoraInicioDia, dtHoraFimDia);
      for (const p of pagsInc) {
        const key =
          p.numeroGuia ||
          p.codigoBarras ||
          p.linhaDigitavel ||
          `${p.numeroInscricao}-${p.valorPago}-${p.dataPagamento || ''}`;
        if (!pagamentosMap.has(key)) pagamentosMap.set(key, p);
      }
    } catch (e) {
      console.warn(`[CONCILIA] Aviso por-data-inclusao(${dataDia}): ${e.message || e}`);
    }

    const todosPagamentos = Array.from(pagamentosMap.values());
    console.log(`[CONCILIA] ${todosPagamentos.length} pagamentos únicos encontrados na SEFAZ para ${dataDia}.`);

    let totalAtualizados = 0;
    const detalhesAtualizados = [];
    for (const pagamento of todosPagamentos) {
      const resultado = await tentarVincularPagamento(pagamento);
      if (resultado?.vinculado) {
        console.log(`--> SUCESSO: Pagamento de ${pagamento.numeroInscricao} (Guia: ${pagamento.numeroGuia || '—'}) atualizado p/ 'Pago'.`);
        totalAtualizados++;

        if (resultado.atualizado && resultado.darId) {
          const resumoDar = await obterResumoDarParaLog(resultado.darId);
          if (resumoDar) {
            detalhesAtualizados.push({
              darId: resultado.darId,
              statusAnterior: resultado.statusAnterior || null,
              statusAtual: resumoDar.status || 'Pago',
              numeroDocumento: resumoDar.numero_documento || null,
              valor: resumoDar.valor,
              dataVencimento: resumoDar.data_vencimento || null,
              dataPagamento: resumoDar.data_pagamento || resultado.pagamento?.data || pagamento.dataPagamento || null,
              origem: resumoDar.origem || null,
              contribuinte: resumoDar.contribuinte || null,
              documentoContribuinte: resumoDar.documento_contribuinte || null,
              pagamento: {
                guia:
                  resultado.pagamento?.guia ||
                  pagamento.numeroGuia ||
                  pagamento.codigoBarras ||
                  pagamento.linhaDigitavel ||
                  null,
                documento: resultado.pagamento?.documento || pagamento.numeroInscricao || null,
                valor: resultado.pagamento?.valor != null ? Number(resultado.pagamento.valor) : pagamento.valorPago || null,
                data: resultado.pagamento?.data || pagamento.dataPagamento || null,
              },
            });
          }
        }
      } else {
        console.warn(`--> ALERTA: Pagamento não vinculado. SEFAZ -> Doc: ${pagamento.numeroInscricao}, Guia: ${pagamento.numeroGuia || '—'}, Valor: ${pagamento.valorPago}`);
      }
    }
    console.log(`[CONCILIA] ${dataDia} finalizado. DARs atualizadas: ${totalAtualizados}/${todosPagamentos.length}.`);

    resumo = {
      dataDia,
      totalPagamentos: todosPagamentos.length,
      totalAtualizados,
      pagamentosAtualizados: detalhesAtualizados,
    };
    sucesso = true;
    return resumo;
  } catch (error) {
    mensagemErro = error?.message || String(error);
    console.error(`[CONCILIA] Falha ao concluir conciliação de ${dataDia}:`, mensagemErro);
    throw error;
  } finally {
    const fimMs = Date.now();
    await registrarConciliacaoLog({
      dataReferencia: dataDia,
      iniciouEm: new Date(inicioMs).toISOString(),
      finalizouEm: new Date(fimMs).toISOString(),
      duracaoMs: fimMs - inicioMs,
      totalPagamentos: resumo.totalPagamentos,
      totalAtualizados: resumo.totalAtualizados,
      sucesso,
      mensagem: mensagemErro,
      pagamentosDetalhes: resumo.pagamentosAtualizados,
    });
  }
}

// ------------------------- Lock simples (anti conc. simultânea) -------------------------
const LOCK_FILE = '/tmp/cipt-concilia.lock';
async function withLock(fn) {
  const fdPath = path.resolve(LOCK_FILE);
  let fd;
  try {
    fd = fs.openSync(fdPath, 'wx'); // falha se já existir
  } catch {
    console.warn('[CONCILIA] Outra instância parece estar rodando. Abortando este ciclo.');
    return;
  }
  try {
    await fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(fdPath); } catch {}
  }
}

async function executarConciliacaoDia(dataISO) {
  let resumo = null;
  let executado = false;

  await withLock(async () => {
    executado = true;
    resumo = await conciliarPagamentosDoDia(dataISO);
  });

  return { executado, resumo };
}

// ------------------------- Agendamento diário (06:00) -------------------------
function scheduleConciliacao() {
  cron.schedule('0 6 * * *', async () => {
    const base = new Date();
    if ((CONCILIAR_BASE_DIA || 'ontem').toLowerCase() !== 'hoje') base.setDate(base.getDate()-1);
    const alvo = ymd(base);
    await withLock(() => conciliarPagamentosDoDia(alvo));
  }, { scheduled:true, timezone:'America/Maceio' });

  console.log('[CONCILIA] Agendador diário iniciado (06:00 America/Maceio).');
}

// Execução direta via CLI:
//   node cron/conciliarPagamentosmes.js                -> roda com CONCILIAR_BASE_DIA (padrão ontem)
//   node cron/conciliarPagamentosmes.js --date=2025-08-27
//   node cron/conciliarPagamentosmes.js --range=2025-08-01:2025-08-28
if (require.main === module) {
  const argDate  = (process.argv.find(a=>a.startsWith('--date=')) || '').split('=')[1];
  const argRange = (process.argv.find(a=>a.startsWith('--range='))|| '').split('=')[1];

  const run = async () => {
    if (argRange) {
      const [ini,fim] = argRange.split(':').map(s=>s.trim());
      const d0 = new Date(`${ini}T00:00:00`);
      const d1 = new Date(`${fim}T00:00:00`);
      for (let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)) {
        await withLock(() => conciliarPagamentosDoDia(ymd(d)));
      }
      return;
    }
    if (argDate) {
      await withLock(() => conciliarPagamentosDoDia(argDate));
      return;
    }
    const base = new Date();
    if ((CONCILIAR_BASE_DIA || 'ontem').toLowerCase() !== 'hoje') base.setDate(base.getDate()-1);
    await withLock(() => conciliarPagamentosDoDia(ymd(base)));
  };

  run()
  .catch(e=>{
    console.error('[CONCILIA] ERRO FATAL:', e?.message || e);
    process.exit(1);
  })
  .finally(()=>{
    db.close(err => { if (err) console.error('[CONCILIA] Erro ao fechar DB:', err.message); });
  });
} else {
  module.exports = { scheduleConciliacao, conciliarPagamentosDoDia, executarConciliacaoDia };
}
