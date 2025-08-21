// src/services/termoEventoPdfkitService.js
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const db = require('../database/db');
const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');

/* ========================= Helpers gerais ========================= */
const cm = (n) => n * 28.3464567; // 1 cm em pontos
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sanitizeForFilename = (s = '') =>
  String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]+/g, '-')
    .replace(/["'`]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

/* pt-BR formatters */
const fmtMoeda = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(Number(n || 0));

const fmtArea = (n) => {
  const num = Number(n || 0);
  return num
    ? `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`
    : '-';
};

const fmtDataExtenso = (isoLike) => {
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
};

const fmtDataBR = (isoLike) => {
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR');
};

/* ========================= SQLite helpers ========================= */
const dbGet = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.get(sql, p, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.all(sql, p, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const dbRun = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.run(sql, p, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

/* ========================= Schema documentos ========================= */
async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`);

  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const names = new Set(cols.map(c => c.name));
  const addIf = async (n, def) => { if (!names.has(n)) await dbRun(`ALTER TABLE documentos ADD COLUMN ${n} ${def}`); };

  await addIf('permissionario_id', 'INTEGER');
  await addIf('evento_id', 'INTEGER');
  await addIf('pdf_url', 'TEXT');
  await addIf('pdf_public_url', 'TEXT');
  await addIf('assinafy_id', 'TEXT');
  await addIf('status', "TEXT DEFAULT 'gerado'");
  await addIf('signed_pdf_public_url', 'TEXT');
  await addIf('signed_at', 'TEXT');
  await addIf('signer', 'TEXT');
  await addIf('created_at', 'TEXT');

  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
}

/* ========================= Blocos de desenho ========================= */
function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, hNeeded = 40) {
  const yLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + hNeeded > yLimit) {
    doc.addPage();
    // applyLetterhead está plugado; apenas reposiciona cursor:
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
  }
}

function drawTituloCabecalho(doc, orgUF, orgSec, orgUni) {
  const w = contentWidth(doc);
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  const opts = { width: w, align: 'center' };
  doc.text(String(orgUF || '').toUpperCase(), opts);
  doc.text(String(orgSec || '').toUpperCase(), opts);
  doc.text(String(orgUni || '').toUpperCase(), opts);
  doc.moveDown(0.8);
}

function drawParagrafoAbertura(doc, texto) {
  // recuo de 6 cm à esquerda e alinhamento justificado
  const left = doc.page.margins.left + cm(6);
  const w = contentWidth(doc) - cm(6);
  ensureSpace(doc, doc.heightOfString(texto, { width: w }));
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  doc.text(texto, left, doc.y, { width: w, align: 'justify' });
  doc.moveDown(0.8);
}

function drawLinhaInfo(doc, rotulo, valor) {
  const w = contentWidth(doc);
  doc.font('Times-Roman').fontSize(12).fillColor('#000')
     .text(`${rotulo} ${valor}`, { width: w, align: 'left' });
}

function drawClausula(doc, titulo) {
  const w = contentWidth(doc);
  ensureSpace(doc, 24);
  doc.moveDown(0.2);
  doc.font('Times-Bold').fontSize(12).fillColor('#000')
     .text(titulo.toUpperCase(), { width: w, align: 'left' });
  doc.moveDown(0.2);
}

function drawParagrafo(doc, texto) {
  const w = contentWidth(doc);
  const h = doc.heightOfString(texto, { width: w, align: 'justify' });
  ensureSpace(doc, h + 6);
  doc.font('Times-Roman').fontSize(12).fillColor('#000')
     .text(texto, { width: w, align: 'justify' });
  doc.moveDown(0.4);
}

function drawTabelaDiscriminacao(doc, dados) {
  const w = contentWidth(doc);
  const cols = [
    { w: Math.round(w * 0.48), label: 'Discriminação / Área utilizada' },
    { w: Math.round(w * 0.20), label: 'Área (m²) / Capacidade' },
    { w: Math.round(w * 0.12), label: 'Nº de dias' },
    { w: Math.round(w * 0.20), label: 'Valor total' },
  ];

  const x0 = doc.page.margins.left;
  let y = doc.y + 6;

  const cellPad = 6;
  const rowMin = 22;

  const drawRow = (cells, yy, bold = false) => {
    let xx = x0;
    const heights = cells.map((c, i) =>
      doc.heightOfString(String(c), { width: cols[i].w - cellPad * 2, align: i === 0 ? 'left' : (i === 3 ? 'right' : 'left') })
    );
    const rowH = Math.max(rowMin, ...heights) + cellPad * 2;

    // nova página se não couber a linha inteira
    ensureSpace(doc, rowH + 4);

    xx = x0;
    for (let i = 0; i < cells.length; i++) {
      doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(11).fillColor('#000')
         .text(String(cells[i]), xx + cellPad, y + cellPad, {
           width: cols[i].w - cellPad * 2,
           align: i === 0 ? 'left' : (i === 3 ? 'right' : 'left')
         });
      doc.rect(xx, y, cols[i].w, rowH).stroke('#000');
      xx += cols[i].w;
    }
    y += rowH;
    doc.y = y;
  };

  // Cabeçalho
  drawRow(cols.map(c => c.label), y, true);
  y = doc.y;

  const col1 = [
    `${dados.discriminacao}`,
    `Realização: ${dados.realizacao}`,
    `Montagem: ${dados.montagem}`,
    `Desmontagem: ${dados.desmontagem}`,
  ].join('\n');

  drawRow(
    [
      col1,
      `${dados.area} (capacidade para ${dados.capacidade} pessoas)`,
      String(dados.dias ?? '-'),
      fmtMoeda(dados.valor || 0),
    ],
    y
  );

  doc.moveDown(0.4);
}

/* ========================= Núcleo: gerar e indexar ========================= */
async function gerarTermoEventoPdfkitEIndexar(eventoId) {
  // 1) Dados do evento + cliente
  const ev = await dbGet(
    `SELECT e.*,
            c.nome_razao_social, c.documento, c.endereco,
            c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [eventoId]
  );
  if (!ev) throw new Error('Evento não encontrado.');

  // 2) Parcelas (para datas de pagamento)
  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.data_vencimento, de.valor_parcela
       FROM DARs_Eventos de
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`,
    [eventoId]
  );

  // 3) Placeholders / Ambiente
  const orgUF  = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj  = process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30';
  const permitenteEnd   = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf= process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const fundoNome  = process.env.FUNDO_NOME || 'FUNDENTES';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;
  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';

  // Datas do evento (array seguro)
  let datasArr = [];
  try {
    if (typeof ev.datas_evento === 'string') {
      datasArr = ev.datas_evento.trim().startsWith('[')
        ? JSON.parse(ev.datas_evento)
        : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(ev.datas_evento)) {
      datasArr = ev.datas_evento;
    }
  } catch {}
  const primeiraDataISO = datasArr[0] || '';

  // Vigência final (fallback = dia seguinte 12h)
  let vigenciaBR = '';
  if (ev.data_vigencia_final) {
    vigenciaBR = `${fmtDataBR(ev.data_vigencia_final)} às 12h`;
  } else if (primeiraDataISO) {
    const d = new Date(primeiraDataISO);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1);
      vigenciaBR = `${d.toLocaleDateString('pt-BR')} às 12h`;
    }
  }

  // Datas de pagamento (50% + 50%) – usa 1ª e 2ª parcelas ou repete a 1ª
  const sinalISO = parcelas[0]?.data_vencimento || '';
  const saldoISO = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || '';
  const sinalBR  = fmtDataExtenso(sinalISO);
  const saldoBR  = fmtDataExtenso(saldoISO);

  // Identificação do permissionário
  const docNum  = onlyDigits(ev.documento || '');
  const isCNPJ  = docNum.length === 14;
  const rotDoc  = isCNPJ ? 'CNPJ' : 'CPF';

  const repNome = (ev.nome_responsavel || '').trim();
  const repDoc  = onlyDigits(ev.documento_responsavel || '');
  const temRep  = repNome && repDoc;

  // 4) Saída / caminhos
  await ensureDocumentosSchema();
  const publicDir = path.join(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(publicDir, { recursive: true });

  const fileName = sanitizeForFilename(
    `TermoPermissao_${String(ev.numero_termo || 's-n').replace(/[\/\\]/g, '-')}_${ev.nome_razao_social || 'Cliente'}_Data-${(primeiraDataISO || 's-d')}.pdf`
  );
  const filePath = path.join(publicDir, fileName);

  // 5) PDF
  const letterheadPath = path.join(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png');
  const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5), bufferPages: true });
  const out = fs.createWriteStream(filePath);
  doc.pipe(out);

  // Timbrado: todas as páginas
  applyLetterhead(doc, { imagePath: letterheadPath });

  // Cursor inicial
  doc.font('Times-Roman').fontSize(12);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;

  // Cabeçalho institucional (3 linhas)
  drawTituloCabecalho(doc, orgUF, orgSec, orgUni);

  // Parágrafo de abertura (recuo 6 cm, justificado)
  const abertura = `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO A ${permitenteRazao.toUpperCase()} E DO OUTRO ${String(ev.nome_razao_social || '').toUpperCase()}.`;
  drawParagrafoAbertura(doc, abertura);

  // Processo / Termo
  drawLinhaInfo(doc, 'Processo n°:', ev.numero_processo || '');
  drawLinhaInfo(doc, 'Termo n°:', ev.numero_termo || '');
  doc.moveDown(0.6);

  // Partes
  drawParagrafo(
    doc,
    `PERMITENTE: ${permitenteRazao}, inscrita no CNPJ/MF sob o nº ${permitenteCnpj} e estabelecida no endereço ${permitenteEnd}, de acordo com a representação legal que lhe é outorgada por portaria e representada pelo responsável: ${permitenteRepCg}, Sr(a). ${permitenteRepNm}, inscrito(a) no CPF sob o nº ${permitenteRepCpf}.`
  );

  const blocoPerm =
    `PERMISSIONÁRIO(A): ${ev.nome_razao_social || ''}, inscrito(a) no ${rotDoc}/MF sob o nº ${docNum || '-'}`
    + (ev.endereco ? ` e estabelecido(a) em ${ev.endereco}` : '')
    + (temRep ? `, representado por ${repNome}, ${isCNPJ ? 'CPF' : 'RG/CPF'} nº ${repDoc}` : '')
    + '.';
  drawParagrafo(doc, blocoPerm);

  // CLÁUSULA 1 – Objeto
  drawClausula(doc, 'Cláusula Primeira – Do Objeto');
  drawParagrafo(
    doc,
    `1.1 - O presente instrumento tem como objeto o uso pelo(a) PERMISSIONÁRIO(A) de área do ${ev.espaco_utilizado || 'AUDITÓRIO'} do imóvel denominado ${imovelNome}, para realização de “${ev.nome_evento || ''}”, a ser realizada em ${fmtDataExtenso(primeiraDataISO) || '-'}, das ${ev.hora_inicio || '-'} às ${ev.hora_fim || '-'}, devendo a montagem ser realizada no mesmo dia do evento e a desmontagem ao final, conforme proposta em anexo, estando disponível o uso do seguinte espaço:`
  );

  // TABELA
  drawTabelaDiscriminacao(doc, {
    discriminacao: `${ev.espaco_utilizado || 'AUDITÓRIO'} do ${imovelNome}`,
    realizacao: fmtDataExtenso(primeiraDataISO) || '-',
    montagem: fmtDataExtenso(primeiraDataISO) || '-',
    desmontagem: fmtDataExtenso(primeiraDataISO) || '-',
    area: fmtArea(ev.area_m2),
    capacidade: capDefault,
    dias: ev.total_diarias || (datasArr.length || 1),
    valor: ev.valor_final || 0,
  });

  // CLÁUSULA 2 – Vigência
  drawClausula(doc, 'Cláusula Segunda – Da Vigência');
  drawParagrafo(doc, `2.1 - O prazo de vigência se inicia na data de assinatura do presente termo até ${vigenciaBR || '-'}.`);

  // CLÁUSULA 3 – Pagamento
  drawClausula(doc, 'Cláusula Terceira – Do Pagamento');
  drawParagrafo(
    doc,
    `3.1 - O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${fmtMoeda(ev.valor_final || 0)}, através de Documento de Arrecadação – DAR, efetuado em favor da conta do Fundo Estadual de Desenvolvimento Científico, Tecnológico e de Educação Superior (${fundoNome}), devendo ser pago o valor de 50% até ${sinalBR || '-'} e o restante até ${saldoBR || '-'}.`
  );
  [
    '3.1.1. Fica incluso ao valor estabelecido no item anterior o pagamento relativo somente ao consumo de água, esgoto e energia elétrica.',
    '3.1.2. Após o pagamento a data estará reservada, de modo que não haverá devolução de qualquer valor pago em caso de desistência.',
    '3.1.3. No caso de não haver a quitação total do valor, a reserva estará desfeita.',
  ].forEach(t => drawParagrafo(doc, t));

  // CLÁUSULA 4 – Obrigações do Permitente
  drawClausula(doc, 'Cláusula Quarta – Das Obrigações do Permitente');
  drawParagrafo(doc, '4.1 - Ceder o espaço, na data e hora acordadas, entregando o local em perfeitas condições de higiene, limpeza e conservação.');
  drawParagrafo(doc, '4.2 - Fiscalizar, por meio do gestor indicado pela SECTI, a utilização do espaço objeto deste termo de permissão, podendo impedir a utilização inadequada do espaço cedido evitando assim danos ao patrimônio do objeto do presente termo de permissão.');
  drawParagrafo(
    doc,
    'Parágrafo Único - Os espaços físicos disponíveis são as áreas do auditório do Centro de Inovação do Jaraguá destinada à realização de eventos, compreendendo o espaço de 429,78 m² (banheiro masculino e feminino, 02 salas de tradução, 09 espaços destinados a cadeirantes, palco - com acesso externo -, 02 coxias, 02 camarins, 01 copa e 01 área técnica), do espaço aberto em frente ao auditório, não incluindo as baias e nem o coworking público, não sendo permitida apresentação musical fora do auditório, bem como não é permitido servir alimentos/bebidas dentro do auditório, de modo que qualquer violação destas será cobrada uma multa no valor de 10% do valor de locação.'
  );

  // CLÁUSULA 5 – Obrigações da Permissionária
  drawClausula(doc, 'Cláusula Quinta – Das Obrigações da Permissionária');
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
  ].forEach(t => drawParagrafo(doc, t));

  // CLÁUSULA 6 – Penalidades
  drawClausula(doc, 'Cláusula Sexta – Das Penalidades');
  [
    '6.1 - O descumprimento das cláusulas ora pactuadas por qualquer das partes acarretará a incidência de multa equivalente a 10% (dez por cento) do valor da permissão, a ser paga pela parte que deu causa em favor da parte inocente.',
    '6.2 - O valor descrito no item anterior deverá ser corrigido com base no IPCA do período correspondente, montante sobre o qual incidirão juros moratórios de 1% (um por cento) ao mês, calculado pro rata die.',
    '6.3 - Na hipótese de rescisão ocasionada pelo(a) PERMISSIONÁRIO(A) por desistência ou cancelamento do evento até os 30 (trinta) dias de antecedência o permissionário deverá ser penalizado com a perda da taxa de reserva mais multa de 20% (vinte por cento) sobre o valor do presente termo.',
    '6.4 - Em caso de violação das normas previstas neste contrato e no regimento interno, e havendo inadimplemento da multa aplicada e/ou ausência de manifestação por parte do permissionário, este poderá ser impedido de realizar reservas dos espaços por até 2 (dois) anos, contados a partir da data da notificação.',
  ].forEach(t => drawParagrafo(doc, t));

  // CLÁUSULA 7 – Rescisão
  drawClausula(doc, 'Cláusula Sétima – Da Rescisão');
  [
    '7.1 - A inexecução total ou parcial deste termo poderá acarretar em sanções administrativas, conforme disposto nos artigos 104, 137, 138 e 139 da Lei nº 14.133/2021.',
    '7.2 – O presente instrumento poderá ser rescindido a qualquer tempo pelo(a) PERMISSIONÁRIO(A), com notificação prévia de, no mínimo, 30 (trinta) dias (para eventos particulares) e 90 (noventa) dias (para eventos públicos) antes da data originalmente agendada para o evento, devidamente protocolada na Secretaria Estadual da Ciência, da Tecnologia e da Inovação de Alagoas – SECTI.',
    '7.2.1 – O não cumprimento do prazo mínimo de notificação impede a realização da alteração de data, sendo considerada desistência definitiva, sujeita às penalidades previstas neste instrumento.',
    '7.2.2 – Nessa hipótese, o(a) PERMISSIONÁRIO(A) terá o direito de realizar o evento em nova data, desde que dentro do prazo máximo de 01 (um) ano a contar da data da assinatura do primeiro termo de permissão de uso, ficando desde já estabelecido que a alteração poderá ocorrer uma única vez, estando a nova data condicionada à disponibilidade de pauta. Caso não haja disponibilidade dentro desse período ou se o evento não for realizado na nova data agendada, o(a) PERMISSIONÁRIO(A) perderá integralmente os valores já pagos.',
    '7.3 - Ocorrerá a rescisão do presente termo de permissão, independente de qualquer comunicação prévia ou indenização por parte da PERMITENTE, havendo qualquer sinistro, incêndio ou algo que venha impossibilitar a posse do espaço, independente de dolo ou culpa do PERMITENTE.',
    '7.4 - Os casos de rescisão devem ser formalmente motivados nos autos do processo, assegurado o contraditório e a ampla defesa.',
  ].forEach(t => drawParagrafo(doc, t));

  // CLÁUSULA 8 – Omissões
  drawClausula(doc, 'Cláusula Oitava – Omissões Contratuais');
  drawParagrafo(doc, '8.1 - Os casos omissos serão decididos pela PERMITENTE segundo as disposições contidas na Lei nº 14.133/2021, e nas demais normas de licitações e contratos administrativos, além de, subsidiariamente, as disposições contidas na Lei nº 8.078/90 – Código de Defesa do Consumidor, e normas e princípios gerais dos contratos.');

  // CLÁUSULA 9 – Foro
  drawClausula(doc, 'Cláusula Nona – Do Foro');
  drawParagrafo(doc, '9.1 - As questões decorrentes da execução deste Instrumento que não possam ser dirimidas administrativamente serão processadas e julgadas no Foro da Cidade de Maceió – AL, que prevalecerá sobre qualquer outro, por mais privilegiado que seja, para dirimir quaisquer dúvidas oriundas do presente Termo.');

  // Fecho
  drawParagrafo(doc, 'Para firmeza e validade do que foi pactuado, lavra-se o presente instrumento em 3 (três) vias de igual teor e forma, para que surtam um só efeito, as quais, depois de lidas, são assinadas pelos representantes das partes, PERMITENTE e PERMISSIONÁRIO(A) e pelas testemunhas abaixo.');
  drawParagrafo(doc, `${cidadeUfDefault}, ${fmtDataExtenso(new Date().toISOString())}.`);

  // Assinaturas (linhas centralizadas)
  const w = contentWidth(doc);
  const linhaAssin = (rotulo) => {
    ensureSpace(doc, 40);
    doc.moveDown(2.2);
    const y0 = doc.y;
    doc.moveTo(doc.page.margins.left, y0).lineTo(doc.page.margins.left + w, y0).stroke();
    doc.moveDown(0.2);
    doc.font('Times-Roman').fontSize(11).text(rotulo, { width: w, align: 'center' });
  };
  linhaAssin('PERMITENTE');
  linhaAssin('PERMISSIONÁRIA');
  linhaAssin('TESTEMUNHA – CPF Nº');
  linhaAssin('TESTEMUNHA – CPF Nº');

  // Paginação: "Página X de Y"
  const range = doc.bufferedPageRange(); // { start, count }
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    doc.font('Times-Roman').fontSize(9).fillColor('#333')
       .text(`Página ${i + 1} de ${range.count}`, right - 120, bottom + 6, { width: 120, align: 'right' });
  }

  // Finaliza gravação
  doc.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });

  // 6) Indexa / UPSERT
  const createdAt = new Date().toISOString();
  const publicUrl = `/documentos/${fileName}`;
  await ensureDocumentosSchema();
  await dbRun(
    `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url, status, created_at)
     VALUES ('termo_evento', NULL, NULL, ?, ?, ?, 'gerado', ?)
     ON CONFLICT(evento_id, tipo) DO UPDATE SET
       pdf_url = excluded.pdf_url,
       pdf_public_url = excluded.pdf_public_url,
       status = 'gerado',
       created_at = excluded.created_at`,
    [eventoId, filePath, publicUrl, createdAt]
  );

  return { filePath, fileName, pdf_public_url: publicUrl, documentoId: null };
}

module.exports = { gerarTermoEventoPdfkitEIndexar };
