// src/api/adminEventosRoutes.js
const express = require('express');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { emitirGuiaSefaz } = require('../services/sefazService');
const { gerarTokenDocumento, imprimirTokenEmPdf } = require('../utils/token');
const { criarEventoComDars, atualizarEventoComDars } = require('../services/eventoDarService');


const { gerarTermoEventoPdfkitEIndexar } = require('../services/termoEventoPdfkitService');

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');
const db = require('../database/db');

const router = express.Router();

/* ========= Helpers gerais ========= */
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sanitizeForFilename = (s = '') =>
    String(s)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\/\\]+/g, '_')
        .replace(/["'`]/g, '')
        .replace(/[^\w.\-]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
const cm = (n) => n * 28.3464567; // 1 cm em pontos PDF

const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n || 0));
const fmtArea = (n) => {
    const num = Number(n || 0);
    return num ? `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²` : '-';
};
const fmtDataExtenso = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
};

/* ========= SQLite helpers com log ========= */
const dbGet = (sql, p = [], ctx = '') =>
    new Promise((resolve, reject) => {
        console.log('[SQL][GET]', ctx, '\n ', sql, '\n ', 'params:', p);
        db.get(sql, p, (err, row) => err ? (console.error('[SQL][GET][ERRO]', ctx, err.message), reject(err)) : (console.log('[SQL][GET][OK]', ctx), resolve(row)));
    });

const dbAll = (sql, p = [], ctx = '') =>
    new Promise((resolve, reject) => {
        console.log('[SQL][ALL]', ctx, '\n ', sql, '\n ', 'params:', p);
        db.all(sql, p, (err, rows) => err ? (console.error('[SQL][ALL][ERRO]', ctx, err.message), reject(err)) : (console.log('[SQL][ALL][OK]', ctx, 'rows:', rows?.length ?? 0), resolve(rows)));
    });

const dbRun = (sql, p = [], ctx = '') =>
    new Promise((resolve, reject) => {
        console.log('[SQL][RUN]', ctx, '\n ', sql, '\n ', 'params:', p);
        db.run(sql, p, function (err) {
            if (err) { console.error('[SQL][RUN][ERRO]', ctx, err.message); reject(err); }
            else { console.log('[SQL][RUN][OK]', ctx, 'lastID:', this.lastID, 'changes:', this.changes); resolve(this); }
        });
    });

function nomeArquivo(ev, idDoc) {
    const razao = String(ev?.nome_razao_social || 'Cliente')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_');

    const termo = String(ev?.numero_termo || 's-n').replace(/[\/\\]+/g, '-');
    const dataPrimeira = (String(ev?.datas_evento || '').split(',')[0] || '').trim();

    return `TermoPermissao_${termo}_${razao}_Data-${dataPrimeira || 's-d'}_${idDoc}.pdf`;
}

/* ========= Schema documentos: garante colunas/índice ========= */
async function ensureDocumentosSchema() {
    await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      token TEXT UNIQUE
    )`, [], 'doc/schema-base');

    const cols = await dbAll(`PRAGMA table_info(documentos)`, [], 'doc/schema-info');
    const have = new Set(cols.map(c => c.name));
    const add = async (name, def) => { if (!have.has(name)) await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`, [], `doc/add-${name}`); };

    await add('permissionario_id', 'INTEGER');
    await add('evento_id', 'INTEGER');
    await add('pdf_url', 'TEXT');
    await add('pdf_public_url', 'TEXT');
    await add('assinafy_id', 'TEXT');
    await add('status', "TEXT DEFAULT 'gerado'");
    await add('signed_pdf_public_url', 'TEXT');
    await add('signed_at', 'TEXT');
    await add('signer', 'TEXT');
    await add('created_at', 'TEXT');

    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`, [], 'doc/index-ux');
}

/* ========= Blocos de desenho PDF ========= */
function drawHeader(doc) {
    // se quiser algo textual além do timbrado, coloque aqui
    // Ex.: doc.fontSize(9).fillColor('#444').text('SECRETARIA...', doc.page.margins.left, doc.page.margins.top - cm(0.8));
}

function drawFooter(doc, page, total) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;

    // Número de página (direita)
    doc.font('Times-Roman').fontSize(9).fillColor('#333')
        .text(`Página ${page} de ${total}`, right - 120, bottom + 6, { width: 120, align: 'right' });
}

function drawTituloCabecalho(doc, orgUF, orgSec, orgUni) {
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font('Times-Bold').fontSize(12).fillColor('#000');
    const opts = { width: largura, align: 'center' };

    doc.text(orgUF?.toUpperCase() || 'ESTADO DE ALAGOAS', opts);
    doc.text(orgSec?.toUpperCase() || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO', opts);
    doc.text(orgUni?.toUpperCase() || 'CENTRO DE INOVAÇÃO DO JARAGUÁ', opts);
    doc.moveDown(0.8);
}

function drawParagrafoAbertura(doc, texto) {
    const left = doc.page.margins.left + cm(6); // recuo de 6 cm
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right - cm(6);
    doc.font('Times-Bold').fontSize(12).fillColor('#000');
    doc.text(texto, left, doc.y, { width: largura, align: 'justify' });
    doc.moveDown(1);
}

function drawLinhaInfo(doc, rotulo, valor) {
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font('Times-Roman').fontSize(12).fillColor('#000')
        .text(`${rotulo} ${valor}`, { width: largura, align: 'left' });
}

function drawParagrafo(doc, texto) {
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font('Times-Roman').fontSize(12).fillColor('#000')
        .text(texto, { width: largura, align: 'justify' });
    doc.moveDown(0.6);
}

function drawClausula(doc, titulo) {
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.moveDown(0.5);
    doc.font('Times-Bold').fontSize(12).text(titulo.toUpperCase(), { width: largura, align: 'left' });
}

function drawTabelaDiscriminacao(doc, dados) {
    const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const cols = [
        { w: largura * 0.47, label: 'Discriminação / Área utilizada' },
        { w: largura * 0.18, label: 'Área (m²) / Capacidade' },
        { w: largura * 0.15, label: 'Nº de dias' },
        { w: largura * 0.20, label: 'Valor total' },
    ];

    const rowH = 20;
    let y = doc.y + 4;
    let x = doc.page.margins.left;

    const drawRow = (cells, yy, bold = false) => {
        let xx = x;
        doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(11);
        cells.forEach((cell, i) => {
            doc.text(String(cell), xx + 4, yy + 5, { width: cols[i].w - 8, align: i === 0 ? 'left' : (i === 3 ? 'right' : 'left') });
            doc.rect(xx, yy, cols[i].w, rowH).stroke('#000');
            xx += cols[i].w;
        });
    };

    // Cabeçalho
    drawRow(cols.map(c => c.label), y, true);
    y += rowH;

    // Conteúdo
    const col1 = [
        dados.discriminacao,
        `Realização: ${dados.realizacao}`,
        `Montagem: ${dados.montagem}`,
        `Desmontagem: ${dados.desmontagem}`,
    ].join('\n');

    drawRow(
        [
            col1,
            `${dados.area} (capacidade para ${dados.capacidade} pessoas)`,
            String(dados.dias),
            fmtMoeda(dados.valor)
        ],
        y
    );

    doc.y = y + rowH + 6;
}

/* ========= Rotas protegidas ========= */
router.use(adminAuthMiddleware);

/**
 * Criar evento + emitir DARs
 */
router.post('/', async (req, res) => {
    console.log('[DEBUG] Recebido no backend /api/admin/eventos:', JSON.stringify(req.body, null, 2));
    try {
        const { eventoGratuito, justificativaGratuito, ...rest } = req.body || {};
        const eventoId = await criarEventoComDars(db, { ...rest, eventoGratuito, justificativaGratuito }, {
            emitirGuiaSefaz,
            gerarTokenDocumento,
            imprimirTokenEmPdf,
        });
        res.status(201).json({ message: 'Evento e DARs criados e emitidos com sucesso!', id: eventoId });
    } catch (err) {
        console.error('[ERRO] Ao criar evento e emitir DARs:', err.message);
        res.status(err.status || 500).json({ error: err.message || 'Não foi possível criar o evento e emitir as DARs.' });
    }
});

/**
 * Listar eventos (admin)
 */
router.get('/', async (_req, res) => {
    try {
        const sql = `
        SELECT e.id, e.nome_evento, e.espaco_utilizado, e.area_m2,
               e.valor_final, e.status, e.data_vigencia_final,
               e.numero_oficio_sei, e.numero_processo, e.numero_termo,
               e.hora_inicio, e.hora_fim, e.hora_montagem, e.hora_desmontagem,
               c.nome_razao_social AS nome_cliente
          FROM Eventos e
          JOIN Clientes_Eventos c ON e.id_cliente = c.id
         ORDER BY e.id DESC`;
        const rows = await dbAll(sql, [], 'listar-eventos');
        res.json(rows);
    } catch (err) {
        console.error('[admin/eventos] listar erro:', err.message);
        res.status(500).json({ error: 'Erro interno no servidor ao buscar eventos.' });
    }
});

/**
 * Listar DARs de um evento
 */
router.get('/:eventoId/dars', async (req, res) => {
    const { eventoId } = req.params;
    try {
        const rows = await dbAll(
            `SELECT
                de.numero_parcela,
                de.valor_parcela,
                d.id AS dar_id,
                d.data_vencimento AS dar_venc,
                d.status AS dar_status,
                d.pdf_url AS dar_pdf
              FROM DARs_Eventos de
              JOIN dars d ON d.id = de.id_dar
             WHERE de.id_evento = ?
             ORDER BY de.numero_parcela ASC`,
            [eventoId],
            'listar-dars-por-evento'
        );
        res.json({ dars: rows });
    } catch (err) {
        console.error('[admin/eventos] listar DARs erro:', err.message);
        res.status(500).json({ error: 'Erro ao listar as DARs do evento.' });
    }
});

/**
 * GET /api/admin/eventos/:id -> detalhes para edição
 */
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const ev = await dbGet(
            `SELECT e.*, c.nome_razao_social AS nome_cliente, c.tipo_cliente
               FROM Eventos e
               JOIN Clientes_Eventos c ON c.id = e.id_cliente
              WHERE e.id = ?`,
            [id],
            'evento/get-by-id'
        );

        if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });

        let datas = [];
        try {
            if (typeof ev.datas_evento === 'string') {
                datas = ev.datas_evento.trim().startsWith('[')
                    ? JSON.parse(ev.datas_evento)
                    : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
            } else if (Array.isArray(ev.datas_evento)) {
                datas = ev.datas_evento;
            }
        } catch { /* noop */ }

        const parcelas = await dbAll(
            `SELECT 
                 de.numero_parcela,
                 de.valor_parcela           AS valor,
                 de.data_vencimento         AS vencimento,
                 d.id                       AS dar_id,
                 d.status                   AS dar_status,
                 d.pdf_url                  AS dar_pdf,
                 d.numero_documento         AS dar_numero
               FROM DARs_Eventos de
               JOIN dars d ON d.id = de.id_dar
              WHERE de.id_evento = ?
              ORDER BY de.numero_parcela ASC`,
            [id],
            'evento/get-parcelas'
        );

        const payload = {
            evento: {
                id: ev.id,
                id_cliente: ev.id_cliente,
                nome_evento: ev.nome_evento,
                espaco_utilizado: ev.espaco_utilizado,
                area_m2: ev.area_m2,
                datas_evento: datas,
                total_diarias: ev.total_diarias,
                valor_bruto: ev.valor_bruto,
                tipo_desconto_auto: ev.tipo_desconto,
                desconto_manual_percent: ev.desconto_manual,
                valor_final: ev.valor_final,
                numero_processo: ev.numero_processo,
                numero_termo: ev.numero_termo,
                evento_gratuito: ev.evento_gratuito,
                justificativa_gratuito: ev.justificativa_gratuito,
                status: ev.status,
                nome_cliente: ev.nome_cliente,
                tipo_cliente: ev.tipo_cliente,
                hora_inicio: ev.hora_inicio,
                hora_fim: ev.hora_fim,
                hora_montagem: ev.hora_montagem,
                hora_desmontagem: ev.hora_desmontagem
            },
            parcelas
        };

        return res.json(payload);
    } catch (err) {
        console.error('[admin/eventos/:id] erro:', err.message);
        return res.status(500).json({ error: 'Erro interno ao buscar o evento.' });
    }
});

/* Alias */
router.get('/:id/detalhes', async (req, res) => {
    req.url = `/${req.params.id}`;
    return router.handle(req, res);
});

/**
 * PUT /api/admin/eventos/:id -> atualiza e reemite DARs
 */
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { eventoGratuito, justificativaGratuito, ...rest } = req.body || {};
        await atualizarEventoComDars(db, id, { ...rest, eventoGratuito, justificativaGratuito }, {
            emitirGuiaSefaz,
            gerarTokenDocumento,
            imprimirTokenEmPdf,
        });
        await atualizarEventoComDars(db, id, req.body, { emitirGuiaSefaz, gerarTokenDocumento, imprimirTokenEmPdf });
        return res.json({ message: 'Evento atualizado e DARs reemitidas com sucesso.', id: Number(id) });
    } catch (err) {
        console.error('[admin/eventos PUT/:id] erro:', err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Erro ao atualizar o evento.' });
    }
});

/**
 * POST /api/admin/eventos/:eventoId/dars/:darId/reemitir
 */
router.post('/:eventoId/dars/:darId/reemitir', async (req, res) => {
    const { eventoId, darId } = req.params;
    console.log(`[ADMIN] Reemitir DAR ID: ${darId} do Evento ID: ${eventoId}`);

    try {
        const row = await dbGet(
            `
          SELECT e.nome_evento,
                 e.hora_inicio, e.hora_fim, e.hora_montagem, e.hora_desmontagem,
                 de.numero_parcela,
                 (SELECT COUNT(*) FROM DARs_Eventos WHERE id_evento = e.id) AS total_parcelas,
                 d.valor, d.data_vencimento,
                 c.nome_razao_social, c.documento, c.endereco, c.cep
            FROM dars d
            JOIN DARs_Eventos de ON d.id = de.id_dar
            JOIN Eventos e        ON de.id_evento = e.id
            JOIN Clientes_Eventos c ON e.id_cliente = c.id
           WHERE d.id = ? AND e.id = ?
            `,
            [darId, eventoId],
            'reemitir/buscar-contexto'
        );

        if (!row) return res.status(404).json({ error: 'DAR ou Evento não encontrado.' });

        const documentoLimpo = onlyDigits(row.documento);
        const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
        const [ano, mes] = row.data_vencimento.split('-');

        const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
        if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');
        const payloadSefaz = {
            versao: '1.0',
            contribuinteEmitente: {
                codigoTipoInscricao: tipoInscricao,
                numeroInscricao: documentoLimpo,
                nome: row.nome_razao_social,
                codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
                descricaoEndereco: row.endereco,
                numeroCep: onlyDigits(row.cep)
            },
            receitas: [{
                codigo: receitaCod,
                competencia: { mes: Number(mes), ano: Number(ano) },
                valorPrincipal: row.valor,
                valorDesconto: 0.00,
                dataVencimento: row.data_vencimento
            }],
            dataLimitePagamento: row.data_vencimento,
            observacao: `CIPT Evento: ${row.nome_evento} (Montagem ${row.hora_montagem || '-'}; Evento ${row.hora_inicio || '-'}-${row.hora_fim || '-'}; Desmontagem ${row.hora_desmontagem || '-'}) | Parcela ${row.numero_parcela}/${row.total_parcelas} (Reemissão)`
        };

        const retornoSefaz = await emitirGuiaSefaz(payloadSefaz);
        const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
        retornoSefaz.pdfBase64 = await imprimirTokenEmPdf(retornoSefaz.pdfBase64, tokenDoc);

        await dbRun(
            `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Reemitido' WHERE id = ?`,
            [retornoSefaz.numeroGuia, retornoSefaz.pdfBase64, darId],
            'reemitir/update-dars'
        );

        console.log(`[ADMIN] DAR ID: ${darId} reemitida. Novo número: ${retornoSefaz.numeroGuia}`);
        res.status(200).json({ message: 'DAR reemitida com sucesso!', ...retornoSefaz });
    } catch (err) {
        console.error(`[ERRO] Ao reemitir DAR ID ${darId}:`, err.message);
        res.status(500).json({ error: err.message || 'Falha ao reemitir a DAR.' });
    }
});

/**
 * Gera o TERMO em PDFKit com timbrado/cabeçalho/rodapé e salva em /public/documentos (idempotente)
 */
router.get('/:id/termo', async (req, res) => {
    const { id } = req.params;
    try {
        // Gera via PDFKit (com timbrado/cabeçalho/rodapé) e indexa
        const out = await gerarTermoEventoPdfkitEIndexar(id);

        const stat = fs.statSync(out.filePath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(out.filePath).pipe(res);
    } catch (err) {
        console.error('[admin/eventos] termo erro:', err);
        res.status(500).json({ error: 'Falha ao gerar termo' });
    }
});


/**
 * (Opcional) Disponibiliza metadados/URL pública já gerada
 */
router.post('/:eventoId/termo/disponibilizar', async (req, res) => {
    try {
        // Aqui, como o GET /:id/termo já gera e indexa, poderíamos apenas consultar o último registro.
        const { eventoId } = req.params;
        await ensureDocumentosSchema();
        const docRow = await dbGet(
            `SELECT * FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`,
            [eventoId],
            'termo/get-doc-row'
        );
        if (!docRow) return res.status(404).json({ ok: false, error: 'Nenhum termo gerado ainda.' });
        return res.json({
            ok: true,
            documentoId: docRow.id,
            pdf_url: docRow.pdf_public_url,
            url_visualizacao: docRow.pdf_public_url
        });
    } catch (err) {
        console.error('[admin disponibilizar termo] erro:', err);
        return res.status(500).json({ ok: false, error: 'Falha ao disponibilizar termo.' });
    }
});

/**
 * DELETE /api/admin/eventos/:eventoId -> apaga evento + DARs
 */
router.delete('/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    console.log(`[ADMIN] Apagar evento ID: ${eventoId}`);

    try {
        await dbRun('BEGIN TRANSACTION', [], 'apagar/BEGIN');

        const darsRows = await dbAll('SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/listar-vinculos');
        const darIds = darsRows.map(r => r.id_dar);

        await dbRun('DELETE FROM DARs_Eventos WHERE id_evento = ?', [eventoId], 'apagar/delete-join');

        if (darIds.length) {
            const placeholders = darIds.map(() => '?').join(',');
            await dbRun(`DELETE FROM dars WHERE id IN (${placeholders})`, darIds, 'apagar/delete-dars');
        }

        const result = await dbRun('DELETE FROM Eventos WHERE id = ?', [eventoId], 'apagar/delete-evento');
        if (!result.changes) throw new Error('Nenhum evento encontrado com este ID.');

        await dbRun('COMMIT', [], 'apagar/COMMIT');

        console.log(`[ADMIN] Evento ${eventoId} e ${darIds.length} DARs apagados.`);
        res.status(200).json({ message: 'Evento e DARs associadas apagados com sucesso!' });
    } catch (err) {
        try { await dbRun('ROLLBACK', [], 'apagar/ROLLBACK'); } catch { }
        console.error(`[ERRO] Ao apagar evento ID ${eventoId}:`, err.message);
        res.status(500).json({ error: 'Falha ao apagar o evento.' });
    }
});

module.exports = router;
