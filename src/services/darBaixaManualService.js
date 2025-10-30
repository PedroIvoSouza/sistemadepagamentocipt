const fs = require('fs');
const path = require('path');

const { gerarTokenDocumento } = require('../utils/token');
const { parseDateInput, formatISODate } = require('../utils/businessDays');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/x-pdf',
  'image/jpeg',
  'image/png',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

const DOCS_DIR = path.join(process.cwd(), 'public', 'documentos');

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function ensureSolicitacoesSchema(db) {
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS dar_baixa_solicitacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dar_id INTEGER NOT NULL,
      permissionario_id INTEGER NOT NULL,
      solicitado_por_tipo TEXT NOT NULL,
      solicitado_por_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pendente',
      data_pagamento TEXT,
      guia_token TEXT,
      comprovante_token TEXT,
      admin_id INTEGER,
      admin_observacao TEXT,
      resposta_em TEXT,
      criado_em TEXT DEFAULT (datetime('now')),
      atualizado_em TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(dar_id) REFERENCES dars(id) ON DELETE CASCADE,
      FOREIGN KEY(permissionario_id) REFERENCES permissionarios(id)
    )`
  );

  const cols = await dbAll(db, `PRAGMA table_info(dar_baixa_solicitacoes)`);
  const have = new Set(cols.map((c) => String(c.name).toLowerCase()));

  const maybeAdd = async (name, ddl) => {
    if (!have.has(name.toLowerCase())) {
      await dbRun(db, `ALTER TABLE dar_baixa_solicitacoes ADD COLUMN ${ddl}`);
    }
  };

  await maybeAdd('admin_observacao', 'admin_observacao TEXT');
  await maybeAdd('resposta_em', "resposta_em TEXT");
  await maybeAdd('atualizado_em', "atualizado_em TEXT DEFAULT (datetime('now'))");
}

function validarArquivo(arquivo, campoLabel) {
  if (!arquivo || !arquivo.buffer || !arquivo.buffer.length) {
    const err = new Error(`Envie o arquivo de ${campoLabel}.`);
    err.status = 400;
    throw err;
  }

  if (arquivo.size > MAX_FILE_SIZE) {
    const err = new Error(`O arquivo de ${campoLabel} excede o limite de 10 MB.`);
    err.status = 400;
    throw err;
  }

  const ext = (path.extname(arquivo.originalname || '') || '').toLowerCase();
  const mime = String(arquivo.mimetype || '').toLowerCase();

  let finalExt = '';
  if (ALLOWED_EXT.has(ext)) {
    finalExt = ext;
  } else if (mime === 'application/pdf' || mime === 'application/x-pdf') {
    finalExt = '.pdf';
  } else if (mime === 'image/jpeg') {
    finalExt = '.jpg';
  } else if (mime === 'image/png') {
    finalExt = '.png';
  }

  if (!finalExt || (!ALLOWED_EXT.has(finalExt) && !ALLOWED_MIME.has(mime))) {
    const err = new Error(`Formato de arquivo inválido para ${campoLabel}. Utilize PDF, JPG ou PNG.`);
    err.status = 400;
    throw err;
  }

  return finalExt;
}

async function armazenarAnexo({
  db,
  darId,
  permissionarioId,
  arquivo,
  tipoDocumento,
  campoLabel,
  tokenExistente = null,
  prefixoArquivo = 'anexo',
}) {
  const extFinal = validarArquivo(arquivo, campoLabel);

  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const baseNome = `${prefixoArquivo}_dar_${darId}_${Date.now()}`;
  const fileName = `${baseNome}${extFinal}`;
  const filePath = path.join(DOCS_DIR, fileName);
  fs.writeFileSync(filePath, arquivo.buffer);

  const publicUrl = `/documentos/${fileName}`;

  let token = tokenExistente || null;
  let documentoAnterior = null;

  if (token) {
    documentoAnterior = await dbGet(db, 'SELECT id, caminho FROM documentos WHERE token = ?', [token]).catch(() => null);
    if (!documentoAnterior) {
      token = null;
    }
  }

  if (!token) {
    token = await gerarTokenDocumento(tipoDocumento, permissionarioId, db);
  }

  await dbRun(
    db,
    `UPDATE documentos
        SET tipo = ?,
            caminho = ?,
            pdf_url = ?,
            pdf_public_url = ?,
            status = 'upload_manual',
            permissionario_id = ?,
            evento_id = NULL,
            created_at = datetime('now')
      WHERE token = ?`,
    [tipoDocumento, filePath, filePath, publicUrl, permissionarioId || null, token]
  );

  const previousPath = documentoAnterior?.caminho && documentoAnterior.caminho !== filePath ? documentoAnterior.caminho : null;

  return { token, filePath, publicUrl, previousPath };
}

function parseDataPagamento(input) {
  const parsed = parseDateInput(input);
  if (!parsed) {
    const err = new Error('Data de pagamento inválida. Utilize o formato AAAA-MM-DD ou DD/MM/AAAA.');
    err.status = 400;
    throw err;
  }
  return formatISODate(parsed);
}

async function registrarSolicitacao({
  db,
  darId,
  permissionarioId,
  solicitadoPorTipo,
  solicitadoPorId,
  status = 'pendente',
  dataPagamentoISO = null,
  guiaToken = null,
  comprovanteToken = null,
  adminId = null,
  adminObservacao = null,
}) {
  await ensureSolicitacoesSchema(db);

  const respostaEm = status === 'pendente' ? null : "datetime('now')";
  const params = [
    darId,
    permissionarioId,
    solicitadoPorTipo,
    solicitadoPorId || null,
    status,
    dataPagamentoISO,
    guiaToken,
    comprovanteToken,
    adminId || null,
    adminObservacao || null,
  ];

  const insertSql = `INSERT INTO dar_baixa_solicitacoes (
      dar_id,
      permissionario_id,
      solicitado_por_tipo,
      solicitado_por_id,
      status,
      data_pagamento,
      guia_token,
      comprovante_token,
      admin_id,
      admin_observacao,
      resposta_em,
      criado_em,
      atualizado_em
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${respostaEm ? respostaEm : 'NULL'}, datetime('now'), datetime('now')
    )`;

  const result = await dbRun(db, insertSql, params);
  return result?.lastID || null;
}

async function atualizarSolicitacao({
  db,
  solicitacaoId,
  status,
  adminId = null,
  adminObservacao = null,
  dataPagamentoISO = null,
}) {
  await ensureSolicitacoesSchema(db);

  const updates = ["status = ?", "atualizado_em = datetime('now')"];
  const params = [status];

  if (dataPagamentoISO) {
    updates.push('data_pagamento = ?');
    params.push(dataPagamentoISO);
  }

  if (adminId !== undefined) {
    updates.push('admin_id = ?');
    params.push(adminId || null);
  }

  if (adminObservacao !== undefined) {
    updates.push('admin_observacao = ?');
    params.push(adminObservacao || null);
  }

  if (status && status !== 'pendente') {
      updates.push("resposta_em = datetime('now')");
  }

  params.push(solicitacaoId);

  await dbRun(db, `UPDATE dar_baixa_solicitacoes SET ${updates.join(', ')} WHERE id = ?`, params);
}

async function obterSolicitacaoPorId(db, solicitacaoId) {
  await ensureSolicitacoesSchema(db);
  return dbGet(db, 'SELECT * FROM dar_baixa_solicitacoes WHERE id = ?', [solicitacaoId]);
}

async function listarSolicitacoes(db, { status = null } = {}) {
  await ensureSolicitacoesSchema(db);
  if (status && status !== 'todos') {
    return dbAll(
      db,
      `SELECT * FROM dar_baixa_solicitacoes WHERE LOWER(status) = LOWER(?) ORDER BY datetime(criado_em) DESC`,
      [status]
    );
  }
  return dbAll(db, `SELECT * FROM dar_baixa_solicitacoes ORDER BY datetime(criado_em) DESC`);
}

async function obterUltimasSolicitacoesPorDar(db, darIds = []) {
  if (!darIds.length) return new Map();
  await ensureSolicitacoesSchema(db);

  const placeholders = darIds.map(() => '?').join(',');
  const rows = await dbAll(
    db,
    `SELECT s.*
       FROM dar_baixa_solicitacoes s
      WHERE s.dar_id IN (${placeholders})
      ORDER BY s.dar_id, datetime(COALESCE(s.atualizado_em, s.criado_em)) DESC`,
    darIds
  );

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.dar_id)) {
      grouped.set(row.dar_id, row);
    }
  }
  return grouped;
}

module.exports = {
  ensureSolicitacoesSchema,
  armazenarAnexo,
  registrarSolicitacao,
  atualizarSolicitacao,
  obterSolicitacaoPorId,
  listarSolicitacoes,
  obterUltimasSolicitacoesPorDar,
  parseDataPagamento,
};

