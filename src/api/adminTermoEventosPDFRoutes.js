// src/api/adminTermoEventosPDFRoutes.js
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');
const { gerarTokenDocumento } = require('../utils/token');

const authMiddleware = require('../middleware/authMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');

const db = require('../database/db');
const router = express.Router();

/* ========= SQLite helpers ========= */
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));

/* ========= Utils ========= */
const CM = 28.3464567; // 1 cm em pontos
const onlyDigits = (v='') => String(v).replace(/\D/g,'');
const sanitize = (s='') =>
  String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]+/g, '-')     // evita criar subpastas
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

const moedaBR = (n) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n||0));
const areaFmt = (n) => {
  const num = Number(n || 0);
  return num ? `${num.toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2})} m²` : '-';
};
const dataExtenso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
};
const primeiraData = (csv) => (String(csv||'').split(',').map(s=>s.trim()).filter(Boolean)[0] || null);

function parseEspacoUtilizado(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const txt = v.trim();
    if (!txt) return [];
    try {
      if (txt.startsWith('[')) {
        const arr = JSON.parse(txt);
        if (Array.isArray(arr)) return arr;
      }
    } catch { /* ignore */ }
    return txt.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/* ========= Monta payload para o termo ========= */
async function buildPayload(eventoId) {
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.endereco,
            c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`, [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado');

  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`, [eventoId]
  );

  const env = {
    ORG_UF: process.env.ORG_UF || 'ESTADO DE ALAGOAS',
    ORG_SECRETARIA: process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO',
    ORG_UNIDADE: process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ',

    PERMITENTE_RAZAO: process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI',
    PERMITENTE_CNPJ:  process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30',
    PERMITENTE_END:   process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140',
    PERMITENTE_REP_NOME: process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO',
    PERMITENTE_REP_CARGO: process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO',
    PERMITENTE_REP_CPF:   process.env.PERMITENTE_REP_CPF   || '053.549.204-93',

    IMOVEL_NOME: process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ',
    CAPACIDADE_PADRAO: Number(process.env.CAPACIDADE_PADRAO || 313),
    FUNDO_NOME: process.env.FUNDO_NOME || 'FUNDENTES',
    CIDADE_UF: process.env.CIDADE_UF || 'Maceió/AL',
  };

  const dataPrimeira = primeiraData(ev.datas_evento);
  const sinal = parcelas[0]?.data_vencimento || null;
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  const payload = {
    org_uf: env.ORG_UF,
    org_secretaria: env.ORG_SECRETARIA,
    org_unidade: env.ORG_UNIDADE,

    processo_numero: ev.numero_processo || '',
    termo_numero: ev.numero_termo || '',

    permitente_razao: env.PERMITENTE_RAZAO,
    permitente_cnpj: env.PERMITENTE_CNPJ,
    permitente_endereco: env.PERMITENTE_END,
    permitente_representante_nome: env.PERMITENTE_REP_NOME,
    permitente_representante_cargo: env.PERMITENTE_REP_CARGO,
    permitente_representante_cpf: env.PERMITENTE_REP_CPF,

    permissionario_razao: ev.nome_razao_social || '',
    permissionario_documento: onlyDigits(ev.documento || ''),
    permissionario_endereco: ev.endereco || '',
    permissionario_representante_nome: ev.nome_responsavel || '',
    permissionario_representante_cpf: onlyDigits(ev.documento_responsavel || ''),

    evento_titulo: ev.nome_evento || '',
    local_espaco: parseEspacoUtilizado(ev.espaco_utilizado).join(', ') || 'AUDITÓRIO',
    imovel_nome: env.IMOVEL_NOME,

    data_evento_iso: dataPrimeira,
    data_evento_ext: dataExtenso(dataPrimeira) || '-',
    hora_inicio: ev.hora_inicio || '-',
    hora_fim: ev.hora_fim || '-',
    data_montagem_ext: dataExtenso(dataPrimeira) || '-',
    data_desmontagem_ext: dataExtenso(dataPrimeira) || '-',

    area_m2: ev.area_m2 || null,
    area_m2_fmt: areaFmt(ev.area_m2),
    capacidade_pessoas: env.CAPACIDADE_PADRAO,

    numero_dias: ev.total_diarias || (String(ev.datas_evento||'').split(',').filter(Boolean).length || 1),
    valor_total: ev.valor_final || 0,
    valor_total_fmt: moedaBR(ev.valor_final || 0),

    vigencia_fim_datahora: ev.data_vigencia_final ? `${new Date(ev.data_vigencia_final+'T12:00:00').toLocaleDateString('pt-BR')} às 12h` : '',

    pagto_sinal_data_ext: dataExtenso(sinal),
    pagto_saldo_data_ext: dataExtenso(saldo),

    fundo_nome: env.FUNDO_NOME,
    cidade_uf: env.CIDADE_UF,
    data_assinatura_ext: dataExtenso(new Date().toISOString()),

    id_cliente: ev.id_cliente,
  };

  return { ev, payload };
}

/* ========= Desenho: cabeçalho (3 linhas) ========= */
function drawCabecalho3Linhas(doc, payload) {
  const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  const lines = [payload.org_uf, payload.org_secretaria, payload.org_unidade];
  lines.forEach((l, i) => {
    doc.text(String(l || '').toUpperCase(), doc.page.margins.left, i === 0 ? doc.y : doc.y, {
      width: larguraUtil,
      align: 'center',
      lineBreak: true
    });
  });
  doc.moveDown(0.8);
}

/* ========= Títulos de cláusula ========= */
function clausulaTitulo(doc, t) {
  doc.moveDown(0.6);
  doc.font('Times-Bold').fontSize(12).fillColor('#000')
     .text(String(t).toUpperCase(), { align:'left' });
  doc.font('Times-Roman').fontSize(12).fillColor('#000');
}

/* ========= Texto justificado padrão ========= */
function p(doc, text, opts = {}) {
  const left = doc.page.margins.left + (opts.indentLeft || 0);
  const larguraUtil = doc.page.width - left - doc.page.margins.right;
  const yStart = typeof opts.y === 'number' ? opts.y : doc.y;
  doc.text(text, left, yStart, {
    width: larguraUtil,
    align: opts.align || 'justify',
    lineGap: 2,
    paragraphGap: 2,
  });
}

/* ========= Tabela 4 colunas ========= */
function tabelaDiscriminacao(doc, payload) {
  const left = doc.page.margins.left;
  const topY = doc.y + 6;
  const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Larguras: 50% | 20% | 10% | 20%
  const cols = [
    { w: larguraUtil * 0.50, label: 'Discriminação/Área utilizada' },
    { w: larguraUtil * 0.20, label: 'Área (m²)/Capacidade' },
    { w: larguraUtil * 0.10, label: 'Nº de dias' },
    { w: larguraUtil * 0.20, label: 'Valor total' },
  ];

  const rowHeight = 24;

  const drawRow = (cells, yy, bold=false) => {
    let x = left;
    doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(12);
    cells.forEach((cell, i) => {
      doc.text(String(cell), x + 4, yy + 6, {
        width: cols[i].w - 8,
        lineBreak: false,
        align: i >= 2 ? 'center' : 'left'
      });
      doc.rect(x, yy, cols[i].w, rowHeight).stroke('#000');
      x += cols[i].w;
    });
  };

  // Cabeçalho
  drawRow(cols.map(c => c.label), topY, true);

  // Conteúdo
  const discr =
    `${payload.local_espaco} do ${payload.imovel_nome}\n` +
    `Realização: ${payload.data_evento_ext}\n` +
    `Montagem: ${payload.data_montagem_ext}\n` +
    `Desmontagem: ${payload.data_desmontagem_ext}`;

  const areaCap = `${payload.area_m2_fmt}\n(capacidade para ${payload.capacidade_pessoas} pessoas)`;

  const cells = [discr, areaCap, String(payload.numero_dias), payload.valor_total_fmt];

  let y = topY + rowHeight;

  // quebra segura
  if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 10) {
    doc.addPage();
    drawRow(cols.map(c => c.label), doc.y, true);
    y = doc.y + rowHeight;
  }
  drawRow(cells, y, false);

  doc.y = y + rowHeight + 6;
}

/* ========= Token no rodapé (sem mexer no cursor) ========= */
function printToken(doc, token) {
  if (!token) return;
  const prevX = doc.x, prevY = doc.y;
  const x = doc.page.margins.left;
  const y = doc.page.height - doc.page.margins.bottom - 10;
  doc.save();
  doc.font('Times-Roman').fontSize(8).fillColor('#222').text(`Token: ${token}`, x, y, { lineBreak: false });
  doc.restore();
  doc.x = prevX; doc.y = prevY;
}

/* ========= Paginação "Página X de Y" ========= */
function printPageNumbers(doc) {
  const range = doc.bufferedPageRange(); // { start, count }
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const left = doc.page.margins.left;
    const larguraUtil = doc.page.width - left - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom - 10;
    doc.font('Times-Roman').fontSize(9).fillColor('#444')
      .text(`Página ${i + 1} de ${range.count}`, left, y, { width: larguraUtil, align: 'right' });
  }
}

/* ========= Nome de arquivo seguro ========= */
function makeFileName(ev, idDoc) {
  const termoNum = sanitize(ev.numero_termo || 's-n'); // evita "042/2025" virar subpasta
  const razao = sanitize(ev.nome_razao_social || 'Cliente');
  const data = sanitize(primeiraData(ev.datas_evento) || 's-d');
  return `TermoPermissao_${termoNum}_${razao}_Data-${data}_${idDoc}.pdf`;
}

/* ========= UPSERT em documentos ========= */
async function upsertDocumento({ tipo, token, permissionario_id, evento_id, filePath, publicUrl }) {
  const createdAt = new Date().toISOString();
  // requer SQLite >= 3.24 (a maioria dos ambientes hoje tem)
  const sql = `
    INSERT INTO documentos (tipo, token, permissionario_id, evento_id, status, created_at, pdf_url, pdf_public_url)
         VALUES (?, ?, ?, ?, 'gerado', ?, ?, ?)
    ON CONFLICT(evento_id, tipo) DO UPDATE SET
         token = excluded.token,
         status = 'gerado',
         created_at = excluded.created_at,
         pdf_url = excluded.pdf_url,
         pdf_public_url = excluded.pdf_public_url
  `;
  await dbRun(sql, [tipo, token, permissionario_id || null, evento_id || null, createdAt, filePath, publicUrl]);
}

/* ===========================================================
   GET /api/admin/eventos/:eventoId/termo-pdf
   Gera o TERMO (PDFKit) com timbrado, cabeçalho e rodapé
   =========================================================== */
router.get(
  '/eventos/:eventoId/termo-pdf',
  [authMiddleware, authorizeRole(['SUPER_ADMIN', 'FINANCE_ADMIN'])],
  async (req, res) => {
    try {
      const { eventoId } = req.params;
      const { ev, payload } = await buildPayload(eventoId);

      // Token do documento
      const tokenDoc = await gerarTokenDocumento('TERMO_EVENTO', Number(eventoId), db);

      // Arquivo de saída
      const outDir = path.join(process.cwd(), 'public', 'documentos');
      fs.mkdirSync(outDir, { recursive: true });

      // Criado já com bufferPages para paginar ao final
      const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5), bufferPages: true });

      // Caminho final só após saber o ID (vamos gerar um temporário primeiro)
      // Estratégia: salvar como arquivo, depois stream pro response.
      const tmpName = `termo_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
      const tmpPath = path.join(outDir, tmpName);
      const fileStream = fs.createWriteStream(tmpPath);
      doc.pipe(fileStream);

      // Timbrado (usa SEU helper do ofício) - caminho que você informou:
      applyLetterhead(doc, { imagePath: path.join(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png') });

      // Primeira página: cursor na área útil + token
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
      printToken(doc, tokenDoc);

      // Repetir token nas próximas
      doc.on('pageAdded', () => {
        printToken(doc, tokenDoc);
      });

      // === Conteúdo ===
      const left = doc.page.margins.left;
      const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // Fonte padrão
      doc.font('Times-Roman').fontSize(12).fillColor('#000');

      // Cabeçalho 3 linhas
      drawCabecalho3Linhas(doc, payload);

      // Título de abertura (JUSTIFICADO com recuo de 6 cm)
      {
        const recuo = 6 * CM; // 6 cm
        const titulo = (
          `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO ` +
          `A ${payload.permitente_razao} E DO OUTRO ` +
          `${payload.permissionario_razao}.`
        ).toUpperCase();

        doc.font('Times-Bold');
        p(doc, titulo, { indentLeft: recuo, align: 'justify' });
        doc.font('Times-Roman');
        doc.moveDown(0.6);
      }

      // Processo / Termo
      p(doc, `Processo n°: ${payload.processo_numero || '-'}`, { align: 'left' });
      p(doc, `Termo n°: ${payload.termo_numero || '-'}`, { align: 'left' });
      doc.moveDown(0.6);

      // PERMITENTE
      p(
        doc,
        `PERMITENTE: ${payload.permitente_razao}, inscrita no CNPJ/MF sob o nº ${payload.permitente_cnpj} ` +
        `e estabelecido(a) no(a) ${payload.permitente_endereco}, de acordo com a representação legal que lhe é ` +
        `outorgada por portaria e representado pelo responsável: ${payload.permitente_representante_cargo}, ` +
        `Sr(a). ${payload.permitente_representante_nome}, inscrito no CPF sob o nº. ${payload.permitente_representante_cpf}.`,
        { align: 'justify' }
      );
      doc.moveDown(0.2);

      // PERMISSIONÁRIO(A)
      p(
        doc,
        `PERMISSIONÁRIO(A): ${payload.permissionario_razao}, inscrito(a) no CNPJ/MF/CPF nº ` +
        `${payload.permissionario_documento || '-'} e estabelecido(a) em ${payload.permissionario_endereco || '-'}, ` +
        `representado por ${payload.permissionario_representante_nome || '-'}, ` +
        `CPF ${payload.permissionario_representante_cpf || '-'}.`,
        { align: 'justify' }
      );

      // CLÁUSULA PRIMEIRA
      clausulaTitulo(doc, 'Cláusula Primeira – Do Objeto');
      p(
        doc,
        `1.1 - O presente instrumento tem como objeto o uso pelo(a) PERMISSIONÁRIO(A) de área do ${payload.local_espaco} ` +
        `do imóvel denominado ${payload.imovel_nome}, para realização da “${payload.evento_titulo}”, a ser realizada em ${payload.data_evento_ext}, ` +
        `das ${payload.hora_inicio} às ${payload.hora_fim}, devendo a montagem ser realizada no mesmo dia do evento e a desmontagem ao final, ` +
        `conforme proposta em anexo, estando disponível o uso do seguinte espaço:`,
        { align: 'justify' }
      );

      // Tabela 4 colunas
      tabelaDiscriminacao(doc, payload);

      // CLÁUSULA SEGUNDA
      clausulaTitulo(doc, 'Cláusula Segunda – Da Vigência');
      p(doc, `2.1 - O prazo de vigência se inicia na data de assinatura do presente termo até ${payload.vigencia_fim_datahora}.`);

      // CLÁUSULA TERCEIRA
      clausulaTitulo(doc, 'Cláusula Terceira – Do Pagamento');
      p(
        doc,
        `3.1 - O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${payload.valor_total_fmt} ` +
        `(por extenso conforme sistema), através de Documento de Arrecadação – DAR, efetuado em favor da conta do ` +
        `Fundo Estadual de Desenvolvimento Científico, Tecnológico e de Educação Superior (${payload.fundo_nome}), ` +
        `devendo ser pago o valor de 50% até ${payload.pagto_sinal_data_ext} e o restante até ${payload.pagto_saldo_data_ext}.`
      );
      p(doc, `3.1.1. Fica incluso ao valor estabelecido no item anterior o pagamento relativo somente ao consumo de água, esgoto e energia elétrica.`);
      p(doc, `3.1.2. Após o pagamento a data estará reservada, de modo que não haverá devolução de qualquer valor pago em caso de desistência.`);
      p(doc, `3.1.3. No caso de não haver a quitação total do valor, a reserva estará desfeita.`);

      // CLÁUSULA QUARTA
      clausulaTitulo(doc, 'Cláusula Quarta – Das Obrigações do Permitente');
      p(doc, `4.1 - Ceder o espaço, na data e hora acordadas, entregando o local em perfeitas condições de higiene, limpeza e conservação.`);
      p(doc, `4.2 - Fiscalizar, por meio do gestor indicado pela SECTI, a utilização do espaço objeto deste termo de permissão, podendo impedir a utilização inadequada do espaço cedido evitando assim danos ao patrimônio do objeto do presente termo de permissão.`);
      p(
        doc,
        `PARÁGRAFO ÚNICO - Os espaços físicos disponíveis são as áreas do auditório do ${payload.imovel_nome} destinada à realização de eventos, ` +
        `compreendido o espaço de ${payload.area_m2_fmt.replace(' m²','')} m² (banheiro masculino e feminino, 02 salas de tradução, 09 espaços destinados a cadeirantes, ` +
        `palco - com acesso externo -, 02 coxias, 02 camarins, 01 copa e 01 área técnica), do espaço aberto em frente ao auditório, não incluindo as baias e nem o ` +
        `coworking público, não sendo permitida apresentação musical fora do auditório, bem como não é permitido servir alimentos/bebidas dentro do auditório, de modo ` +
        `que qualquer violação destas será cobrada uma multa no valor de 10% do valor de locação.`
      );

      // CLÁUSULA QUINTA
      clausulaTitulo(doc, 'Cláusula Quinta – Das Obrigações da Permissionária');
      [
        '5.1 - Utilizar o espaço destinado no imóvel em questão para o fim específico do evento descrito na cláusula primeira.',
        '5.2 - Conservar o imóvel como se lhe pertencesse, fazendo com que seu uso e gozo sejam pacíficos e harmônicos.',
        '5.3 - A montagem e desmontagem de materiais e equipamentos do(a) PERMISSIONÁRIO(A) ou de terceiros, dentro do período de vigência, conforme reserva.',
        '5.4 - A indenização pelos danos causados que, por si, seus empregados, prepostos e participantes do evento causarem ao mobiliário, equipamentos e acessórios das áreas locadas, independente de qualquer vistoria judicial prévia.',
        '5.5 - A indenização por danos causados a terceiros no imóvel utilizado.',
        '5.6 - A retirada do material e equipamentos utilizados dentro do período de vigência.',
        '5.7 - Respeitar a lotação da área utilizada, sob pena do PERMITENTE providenciar a retirada do público excedente.',
        '5.8 - Responsabilizar-se pelas despesas realizadas com a segurança, manutenção e conservação do bem permitido.',
        '5.9 - Responsabilizar-se pela limpeza e manutenção da área locada durante a montagem, realização e desmontagem do evento, inclusive a compra dos materiais de limpeza.',
        '5.10 - Responsabilizar-se pela locação de container e contratação de remoção de lixo durante a montagem, realização e desmontagem do evento.',
        '5.11 - Restituir o espaço permitido em perfeito estado e condições, conforme Termo de Vistoria.',
        '5.12 - O espaço locado deverá ser utilizado para o fim específico do evento descrito na cláusula primeira.',
        '5.13 - Para a locação da referida área, o permissionário deverá, no momento da montagem do evento, participar de um check list de vistoria junto a servidor designado pela SECTI e, ao final do evento, na desmontagem, entregar o espaço nas mesmas condições encontradas, incluindo infraestrutura, mobília e limpeza do ambiente, sob pena de multa no valor de locação do espaço.',
        '5.14 - O permissionário deverá apresentar o projeto do evento com o layout, incluindo os pontos de iluminação, para que seja atestada a necessidade de ser utilizado ou não gerador. Caso seja atestada a necessidade, o permissionário deverá arcar com o aluguel de um gerador externo para não sobrecarregar a rede elétrica do Centro de Inovação do Jaraguá, de modo a evitar danos à estrutura.',
        '5.15 - Toda estrutura que não for retirada no dia da desmontagem que consta neste termo de permissão de uso será destinada a outros fins, bem como será aplicada multa no valor de 10% da locação.',
        '5.16 - É vedada a utilização da porta de emergência para fins que não seja de segurança, tais como movimentação de estrutura de eventos, sob pena de multa em caso de desobediência.',
        '5.17 - É proibido o consumo de comidas/bebidas dentro do auditório ou do anfiteatro, de modo que havendo violação deverá ser aplicada multa de 10% do valor de locação, bem como deverá arcar com o valor de danos, caso tenha ocorrido.',
        '5.18 - É proibido som e/ou apresentação musical fora do auditório, sob pena de multa.',
      ].forEach(txt => p(doc, txt));

      // CLÁUSULA SEXTA
      clausulaTitulo(doc, 'Cláusula Sexta – Das Penalidades');
      [
        '6.1 - O descumprimento das cláusulas ora pactuadas por qualquer das partes acarretará a incidência de multa equivalente a 10% (dez por cento) do valor da permissão, a ser paga pela parte que deu causa em favor da parte inocente.',
        '6.2 - O valor descrito no item anterior deverá ser corrigido com base no IPCA do período correspondente, montante sobre o qual incidirão juros moratórios de 1% (um por cento) ao mês, calculado pro rata die.',
        '6.3 - Na hipótese de rescisão ocasionada pelo(a) PERMISSIONÁRIO(A) por desistência ou cancelamento do evento até os 30 (trinta) dias de antecedência o permissionário deverá ser penalizado com a perda da taxa de reserva mais multa de 20% (vinte por cento) sobre o valor do presente termo.',
        '6.4 - Em caso de violação das normas previstas neste contrato e no regimento interno, e havendo inadimplemento da multa aplicada e/ou ausência de manifestação por parte do permissionário, este poderá ser impedido de realizar reservas dos espaços por até 2 (dois) anos, contados a partir da data da notificação.',
      ].forEach(txt => p(doc, txt));

      // CLÁUSULA SÉTIMA
      clausulaTitulo(doc, 'Cláusula Sétima – Da Rescisão');
      [
        '7.1 - A inexecução total ou parcial deste termo poderá acarretar em sanções administrativas, conforme disposto nos artigos 104, 137, 138 e 139 da Lei nº 14.133/2021.',
        '7.2 – O presente instrumento poderá ser rescindido a qualquer tempo pelo(a) PERMISSIONÁRIO(A), com notificação prévia de, no mínimo, 30 (trinta) dias (para eventos particulares) e 90 (noventa) dias (para eventos públicos) antes da data originalmente agendada para o evento, devidamente protocolada na Secretaria Estadual da Ciência, da Tecnologia e da Inovação de Alagoas – SECTI.',
        '7.2.1 – O não cumprimento do prazo mínimo de notificação impede a realização da alteração de data, sendo considerada desistência definitiva, sujeita às penalidades previstas neste instrumento.',
        '7.2.2 – Nessa hipótese, o(a) PERMISSIONÁRIO(A) terá o direito de realizar o evento em nova data, desde que dentro do prazo máximo de 01 (um) ano a contar da data da assinatura do primeiro termo de permissão de uso, ficando desde já estabelecido que a alteração poderá ocorrer uma única vez, estando a nova data condicionada à disponibilidade de pauta. Caso não haja disponibilidade dentro desse período ou se o evento não for realizado na nova data agendada, o(a) PERMISSIONÁRIO(A) perderá integralmente os valores já pagos.',
        '7.3 - Ocorrerá a rescisão do presente termo de permissão, independente de qualquer comunicação prévia ou indenização por parte da PERMITENTE, havendo qualquer sinistro, incêndio ou algo que venha impossibilitar a posse do espaço, independente de dolo ou culpa do PERMITENTE.',
        '7.4 - Os casos de rescisão devem ser formalmente motivados nos autos do processo, assegurado o contraditório e a ampla defesa.',
      ].forEach(txt => p(doc, txt));

      // CLÁUSULA OITAVA
      clausulaTitulo(doc, 'Cláusula Oitava – Omissões Contratuais');
      p(doc, '8.1 - Os casos omissos serão decididos pela PERMITENTE segundo as disposições contidas na Lei nº 14.133/2021, e nas demais normas de licitações e contratos administrativos, além de, subsidiariamente, as disposições contidas na Lei nº 8.078/90 – Código de Defesa do Consumidor, e normas e princípios gerais dos contratos.');

      // CLÁUSULA NONA
      clausulaTitulo(doc, 'Cláusula Nona – Do Foro');
      p(doc, '9.1 - As questões decorrentes da execução deste Instrumento que não possam ser dirimidas administrativamente serão processadas e julgadas no Foro da Cidade de Maceió – AL, que prevalecerá sobre qualquer outro, por mais privilegiado que seja, para dirimir quaisquer dúvidas oriundas do presente Termo.');

      doc.moveDown(1.2);
      p(doc, `${payload.cidade_uf}, ${payload.data_assinatura_ext}.`, { align: 'left' });

      // Assinaturas
      doc.moveDown(3);
      const signWidth = larguraUtil;
      const line = (label) => {
        const y0 = doc.y;
        // linha
        doc.moveTo(left + signWidth*0.15, y0).lineTo(left + signWidth*0.85, y0).stroke('#000');
        doc.moveDown(0.3);
        doc.font('Times-Roman').fontSize(11).text(label, left, doc.y, { width: larguraUtil, align: 'center' });
        doc.moveDown(1.8);
      };
      line('PERMITENTE');
      line('PERMISSIONÁRIA');
      line('TESTEMUNHA – CPF Nº');
      line('TESTEMUNHA – CPF Nº');

      // Paginar
      printPageNumbers(doc);

      // Finaliza doc: fecha stream e só então indexa + devolve
      doc.end();

      fileStream.on('finish', async () => {
        try {
          // Descobre ID (inserindo primeiro um placeholder)
          const tmpToken = tokenDoc;
          // Vamos salvar com nome final que usa o ID do registro (depois do UPSERT consultamos o ROWID)
          // Estratégia: primeiro upsert com caminho temporário, depois renomear arquivo e atualizar caminhos.

          // 1) upsert inicial com tmp
          await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT NOT NULL,
            token TEXT,
            permissionario_id INTEGER,
            evento_id INTEGER,
            status TEXT,
            created_at TEXT,
            pdf_url TEXT,
            pdf_public_url TEXT,
            assinafy_id TEXT,
            signed_pdf_public_url TEXT,
            signed_at TEXT,
            signer TEXT
          )`);
          await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);

          const tipo = 'termo_evento_pdfkit';
          const tmpPublic = `/documentos/${path.basename(tmpPath)}`;
          await upsertDocumento({
            tipo,
            token: tmpToken,
            permissionario_id: payload.id_cliente,
            evento_id: Number(eventoId),
            filePath: tmpPath,
            publicUrl: tmpPublic,
          });

          // 2) pega o registro pra obter o id
          const row = await dbGet(`SELECT id FROM documentos WHERE evento_id = ? AND tipo = ?`, [eventoId, tipo]);
          const finalName = makeFileName(ev, row.id);
          const finalPath = path.join(path.dirname(tmpPath), finalName);
          fs.renameSync(tmpPath, finalPath);
          const finalPublic = `/documentos/${finalName}`;

          // 3) atualiza com o caminho final
          await dbRun(
            `UPDATE documentos SET pdf_url = ?, pdf_public_url = ? WHERE id = ?`,
            [finalPath, finalPublic, row.id]
          );

          // 4) responde fazendo o download
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${finalName}"`);
          res.setHeader('X-Document-Token', tmpToken);
          fs.createReadStream(finalPath).pipe(res);
        } catch (e) {
          console.error('[termo-pdf] pós-geração erro:', e);
          res.status(500).json({ error: 'Erro ao finalizar o PDF do termo.' });
        }
      });
    } catch (err) {
      console.error('[adminTermoEventosPDF] erro:', err);
      res.status(500).json({ error: 'Erro ao gerar termo.' });
    }
  }
);

module.exports = router;
