// src/services/termoEventoPdfkitService.js
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('../database/db');
const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');

/* ========= Helpers ========= */
const cm = (n) => n * 28.3464567; // 1 cm em pt
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sanitizeForFilename = (s = '') =>
  String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]+/g, '_')
    .replace(/["'`]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

const fmtMoeda = (n) => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' })
  .format(Number(n || 0));

const fmtArea = (n) => {
  const num = Number(n || 0);
  return num ? `${num.toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2})} m²` : '-';
};

const fmtDataExtenso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
};

/* ========= SQLite helpers ========= */
const dbGet = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.get(sql, p, (err, row) => err ? reject(Object.assign(err, { ctx })) : resolve(row));
  });
const dbAll = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.all(sql, p, (err, rows) => err ? reject(Object.assign(err, { ctx })) : resolve(rows));
  });
const dbRun = (sql, p = [], ctx = '') =>
  new Promise((resolve, reject) => {
    db.run(sql, p, function (err) {
      if (err) reject(Object.assign(err, { ctx }));
      else resolve(this);
    });
  });

/* ========= Schema documentos (idempotente) ========= */
async function ensureDocumentosSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`);
  const cols = await dbAll(`PRAGMA table_info(documentos)`);
  const have = new Set(cols.map(c => c.name));
  const add = async (name, def) => { if (!have.has(name)) await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`); };
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
  await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
}

/* ========= Desenho do documento ========= */
function drawTituloCabecalho(doc, orgUF, orgSec, orgUni) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  doc.text((orgUF || 'ESTADO DE ALAGOAS').toUpperCase(), doc.page.margins.left, doc.page.margins.top, { width: largura, align: 'center' });
  doc.moveDown(0.2);
  doc.text((orgSec || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO').toUpperCase(), { width: largura, align: 'center' });
  doc.moveDown(0.2);
  doc.text((orgUni || 'CENTRO DE INOVAÇÃO DO JARAGUÁ').toUpperCase(), { width: largura, align: 'center' });
  doc.moveDown(0.8);
}

function drawParagrafoAbertura(doc, texto) {
  // “justificado com margem de 6 cm” (recuo à esquerda 6 cm)
  const left = doc.page.margins.left + cm(6);
  const largura = doc.page.width - left - doc.page.margins.right;
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  doc.text(texto, left, doc.y, { width: largura, align: 'justify' });
  doc.moveDown(1);
}

function drawLinhaInfo(doc, rotulo, valor) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12).fillColor('#000');
  doc.text(`${rotulo} ${valor}`, { width: largura, align: 'left' });
}

function drawClausulaTitulo(doc, titulo) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.5);
  doc.font('Times-Bold').fontSize(12).text(titulo.toUpperCase(), { width: largura, align: 'left' });
  doc.moveDown(0.2);
}

function drawParagrafo(doc, texto) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12).fillColor('#000');
  doc.text(texto, { width: largura, align: 'justify' });
  doc.moveDown(0.6);
}

function drawTabelaDiscriminacao(doc, dados) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const cols = [
    { w: width * 0.47, label: 'Discriminação/Área utilizada' },
    { w: width * 0.18, label: 'Área (m²)/Capacidade' },
    { w: width * 0.15, label: 'Nº de dias' },
    { w: width * 0.20, label: 'Valor total' },
  ];

  let y = doc.y + 4;

  const textHeight = (str, w, font='Times-Roman', size=11) => {
    const prevFont = doc._font, prevSize = doc._fontSize;
    doc.font(font).fontSize(size);
    const h = doc.heightOfString(String(str), { width: w - 8 });
    doc.font(prevFont.name).fontSize(prevSize);
    return h;
  };

  const drawRow = (cells, yy, options = { bold:false }) => {
    const heights = cells.map((c, i) => textHeight(c, cols[i].w, options.bold ? 'Times-Bold' : 'Times-Roman', 11));
    const rowH = Math.max(...heights) + 10; // padding vertical
    // quebra de página se necessário
    const limit = doc.page.height - doc.page.margins.bottom - 30;
    if (yy + rowH > limit) {
      doc.addPage(); // cabeçalho textual da página nova será inserido pelo on('pageAdded')
      y = doc.y + 4;
      return drawRow(cells, y, options); // redesenha na nova página
    }
    let x = left;
    doc.font(options.bold ? 'Times-Bold' : 'Times-Roman').fontSize(11).fillColor('#000');
    cells.forEach((cell, i) => {
      const align = i === 3 ? 'right' : 'left';
      doc.text(String(cell), x + 4, yy + 5, { width: cols[i].w - 8, align });
      doc.rect(x, yy, cols[i].w, rowH).stroke('#000');
      x += cols[i].w;
    });
    doc.y = yy + rowH;
  };

  // cabeçalho
  drawRow(cols.map(c => c.label), y, { bold:true });
  y = doc.y;

  // conteúdo
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
      fmtMoeda(dados.valor),
    ],
    y,
    { bold:false }
  );

  doc.moveDown(0.8);
}

/* ========= Geração do PDF ========= */
async function gerarTermoEventoPdfkitEIndexar(eventoId) {
  // 1) Carrega evento + cliente
  const ev = await dbGet(
    `SELECT e.*, c.nome_razao_social, c.documento, c.endereco, c.cep, c.nome_responsavel, c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [eventoId],
    'termo/ev'
  );
  if (!ev) throw new Error('Evento não encontrado.');

  // 2) Parcelas
  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`,
    [eventoId],
    'termo/parcelas'
  );

  // 3) Placeholders das variáveis (.env + evento)
  const orgUF  = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj  = process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30';
  const permitenteEnd   = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf= process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  // datas
  let datasArr = [];
  try {
    if (typeof ev.datas_evento === 'string') {
      datasArr = ev.datas_evento.trim().startsWith('[')
        ? JSON.parse(ev.datas_evento)
        : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(ev.datas_evento)) {
      datasArr = ev.datas_evento;
    }
  } catch {/* noop */}
  const primeiraDataISO = datasArr[0] || '';
  const dataEventoExt = fmtDataExtenso(primeiraDataISO) || '-';
  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
  const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capacidade = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;

  const sinal = parcelas[0]?.data_vencimento || '';
  const saldo = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || '';

  // 4) Arquivo e timbrado
  const publicDir = path.join(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(publicDir, { recursive: true });

  const fileName = sanitizeForFilename(
    `TermoPermissao_${String(ev.numero_termo || 's-n').replace(/[\/\\]/g,'-')}_${(ev.nome_razao_social || 'Cliente')}_${(primeiraDataISO || 's-d')}.pdf`
  );
  const filePath = path.join(publicDir, fileName);

  // tenta `public/images/papel-timbrado-secti.png`, senão cai para assets
  let letterheadPath = path.join(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png');
  if (!fs.existsSync(letterheadPath)) {
    letterheadPath = path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png');
  }

  // 5) Monta PDF (bufferPages para numerar no fim)
  const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5), bufferPages: true });
  const ws = fs.createWriteStream(filePath);
  doc.pipe(ws);

  // timbrado em TODAS as páginas
  applyLetterhead(doc, { imagePath: letterheadPath });

  // ao adicionar nova página pelo fluxo automático, escrever o cabeçalho textual de 3 linhas
  doc.on('pageAdded', () => {
    drawTituloCabecalho(doc, orgUF, orgSec, orgUni);
  });

  // página 1: cursor e cabeçalho
  doc.font('Times-Roman').fontSize(12);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
  drawTituloCabecalho(doc, orgUF, orgSec, orgUni);

  // Abertura — exatamente como você pediu, com recuo de 6 cm e texto integral
  const abertura = `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO A ${permitenteRazao} E DO OUTRO ${String(ev.nome_razao_social || '').toUpperCase()}.`;
  drawParagrafoAbertura(doc, abertura);

  // Processo / Termo
  drawLinhaInfo(doc, 'Processo n°:', ev.numero_processo || '');
  drawLinhaInfo(doc, 'Termo n°:', ev.numero_termo || '');
  doc.moveDown(0.6);

  // Partes (texto integral, sem resumir)
  drawParagrafo(
    doc,
    `PERMITENTE: A ${permitenteRazao}, inscrita no CNPJ/MF sob o nº ${permitenteCnpj} e estabelecido(a) no(a) ${permitenteEnd}, de acordo com a representação legal que lhe é outorgada por portaria e representado pelo responsável: ${permitenteRepCg}, Sr. ${permitenteRepNm}, inscrito no CPF sob o nº. ${permitenteRepCpf}.`
  );

  drawParagrafo(
    doc,
    `PERMISSIONÁRIO(A): ${ev.nome_razao_social || ''}, inscrito(a) no CNPJ/MF sob o nº ${onlyDigits(ev.documento || '')} e estabelecido(a) em ${ev.endereco || '-'}, representado por ${ev.nome_responsavel || '-'}, inscrito(a) no CPF sob o nº ${onlyDigits(ev.documento_responsavel || '')}.`
  );

  // CLÁUSULA PRIMEIRA – DO OBJETO
  drawClausulaTitulo(doc, 'Cláusula Primeira: Do Objeto');
  drawParagrafo(
    doc,
    `1.1 - O presente instrumento tem como objeto o uso pelo(a) PERMISSIONÁRIO(A) de área do ${ev.espaco_utilizado || 'AUDITÓRIO'} do imóvel denominado ${imovelNome}, para realização da “${ev.nome_evento || ''}”, a ser realizada no dia ${dataEventoExt}, das ${ev.hora_inicio || '-'} às ${ev.hora_fim || '-'}, devendo a montagem ser realizada no mesmo dia do evento e a desmontagem ao final, conforme proposta em anexo, estando disponível o uso do seguinte espaço:`
  );

  // Tabela (4 colunas)
  drawTabelaDiscriminacao(doc, {
    discriminacao: `${ev.espaco_utilizado || 'AUDITÓRIO'} do ${imovelNome}`,
    realizacao: dataEventoExt || '-',
    montagem: dataEventoExt || '-',
    desmontagem: dataEventoExt || '-',
    area: fmtArea(ev.area_m2),
    capacidade,
    dias: ev.total_diarias || (datasArr.length || 1),
    valor: ev.valor_final || 0,
  });

  // CLÁUSULA SEGUNDA – DA VIGÊNCIA
  drawClausulaTitulo(doc, 'Cláusula Segunda – Da Vigência');
  drawParagrafo(
    doc,
    `2.1 - O prazo de vigência se inicia na data de assinatura do presente termo até ${ev.data_vigencia_final ? new Date(ev.data_vigencia_final).toLocaleDateString('pt-BR') : '-'}, às 12h.`
  );

  // CLÁUSULA TERCEIRA – DO PAGAMENTO (texto integral)
  drawClausulaTitulo(doc, 'Cláusula Terceira – Do Pagamento');
  drawParagrafo(
    doc,
    `3.1 - O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${fmtMoeda(ev.valor_final || 0)}, através de Documento de Arrecadação – DAR, efetuado em favor da conta do Fundo Estadual de Desenvolvimento Científico, Tecnológico e de Educação Superior (${fundoNome}), devendo ser pago o valor de 50% até ${fmtDataExtenso(sinal)} e o restante até ${fmtDataExtenso(saldo)}.`
  );
  drawParagrafo(doc, '3.1.1. Fica incluso ao valor estabelecido no item anterior o pagamento relativo somente ao consumo de água, esgoto e energia elétrica.');
  drawParagrafo(doc, '3.1.2. Após o pagamento a data estará reservada, de modo que não haverá devolução de qualquer valor pago em caso de desistência.');
  drawParagrafo(doc, '3.1.3. No caso de não haver a quitação total do valor, a reserva estará desfeita.');

  // CLÁUSULA QUARTA – OBRIGAÇÕES DO PERMITENTE
  drawClausulaTitulo(doc, 'Cláusula Quarta – Das Obrigações do Permitente');
  drawParagrafo(doc, '4.1 - Ceder o espaço, na data e hora acordadas, entregando o local em perfeitas condições de higiene, limpeza e conservação.');
  drawParagrafo(doc, '4.2 - Fiscalizar, por meio do gestor indicado pela SECTI, a utilização do espaço objeto deste termo de permissão, podendo impedir a utilização inadequada do espaço cedido evitando assim danos ao patrimônio do objeto do presente termo de permissão.');
  drawParagrafo(
    doc,
    'Parágrafo Único - Os espaços físicos disponíveis são as áreas do auditório do Centro de Inovação do Jaraguá destinada à realização de eventos, compreendido o espaço de 429,78 m² (banheiro masculino e feminino, 02 salas de tradução, 09 espaços destinados a cadeirantes, palco - com acesso externo -, 02 coxias, 02 camarins, 01 copa e 01 área técnica), do espaço aberto em frente ao auditório, não incluindo as baias e nem o coworking público, não sendo permitida apresentação musical fora do auditório, bem como não é permitido servir alimentos/bebidas dentro do auditório, de modo que qualquer violação destas será cobrada uma multa no valor de 10% do valor de locação.'
  );

  // CLÁUSULA QUINTA – OBRIGAÇÕES DA PERMISSIONÁRIA
  drawClausulaTitulo(doc, 'Cláusula Quinta – Das Obrigações da Permissionária');
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
  ].forEach(p => drawParagrafo(doc, p));

  // CLÁUSULA SEXTA – PENALIDADES
  drawClausulaTitulo(doc, 'Cláusula Sexta – Das Penalidades');
  [
    '6.1 - O descumprimento das cláusulas ora pactuadas por qualquer das partes acarretará a incidência de multa equivalente a 10% (dez por cento) do valor da permissão, a ser paga pela parte que deu causa em favor da parte inocente.',
    '6.2 - O valor descrito no item anterior deverá ser corrigido com base no IPCA do período correspondente, montante sobre o qual incidirão juros moratórios de 1% (um por cento) ao mês, calculado pro rata die.',
    '6.3 - Na hipótese de rescisão ocasionada pelo(a) PERMISSIONÁRIO(A) por desistência ou cancelamento do evento até os 30 (trinta) dias de antecedência o permissionário deverá ser penalizado com a perda da taxa de reserva mais multa de 20% (vinte por cento) sobre o valor do presente termo.',
    '6.4 - Em caso de violação das normas previstas neste contrato e no regimento interno, e havendo inadimplemento da multa aplicada e/ou ausência de manifestação por parte do permissionário, este poderá ser impedido de realizar reservas dos espaços por até 2 (dois) anos, contados a partir da data da notificação.',
  ].forEach(p => drawParagrafo(doc, p));

  // CLÁUSULA SÉTIMA – RESCISÃO
  drawClausulaTitulo(doc, 'Cláusula Sétima – Da Rescisão');
  [
    '7.1 - A inexecução total ou parcial deste termo poderá acarretar em sanções administrativas, conforme disposto nos artigos 104, 137, 138 e 139 da Lei nº 14.133/2021.',
    '7.2 – O presente instrumento poderá ser rescindido a qualquer tempo pelo(a) PERMISSIONÁRIO(A), com notificação prévia de, no mínimo, 30 (trinta) dias (para eventos particulares) e 90 (noventa) dias (para eventos públicos) antes da data originalmente agendada para o evento, devidamente protocolada na Secretaria Estadual da Ciência, da Tecnologia e da Inovação de Alagoas – SECTI.',
    '7.2.1 – O não cumprimento do prazo mínimo de notificação impede a realização da alteração de data, sendo considerada desistência definitiva, sujeita às penalidades previstas neste instrumento.',
    '7.2.2 – Nessa hipótese, o(a) PERMISSIONÁRIO(A) terá o direito de realizar o evento em nova data, desde que dentro do prazo máximo de 01 (um) ano a contar da data da assinatura do primeiro termo de permissão de uso, ficando desde já estabelecido que a alteração poderá ocorrer uma única vez, estando a nova data condicionada à disponibilidade de pauta. Caso não haja disponibilidade dentro desse período ou se o evento não for realizado na nova data agendada, o(a) PERMISSIONÁRIO(A) perderá integralmente os valores já pagos.',
    '7.3 - Ocorrerá a rescisão do presente termo de permissão, independente de qualquer comunicação prévia ou indenização por parte da PERMITENTE, havendo qualquer sinistro, incêndio ou algo que venha impossibilitar a posse do espaço, independente de dolo ou culpa do PERMITENTE.',
    '7.4 - Os casos de rescisão devem ser formalmente motivados nos autos do processo, assegurado o contraditório e a ampla defesa.',
  ].forEach(p => drawParagrafo(doc, p));

  // CLÁUSULA OITAVA – OMISSÕES
  drawClausulaTitulo(doc, 'Cláusula Oitava – Omissões Contratuais');
  drawParagrafo(doc, '8.1 - Os casos omissos serão decididos pela PERMITENTE segundo as disposições contidas na Lei nº 14.133/2021, e nas demais normas de licitações e contratos administrativos, além de, subsidiariamente, as disposições contidas na Lei nº 8.078/90 – Código de Defesa do Consumidor, e normas e princípios gerais dos contratos.');

  // CLÁUSULA NONA – FORO
  drawClausulaTitulo(doc, 'Cláusula Nona – Do Foro');
  drawParagrafo(doc, '9.1 As questões decorrentes da execução deste Instrumento que não possam ser dirimidas administrativamente serão processadas e julgadas no Foro da Cidade de Maceió – AL, que prevalecerá sobre qualquer outro, por mais privilegiado que seja, para dirimir quaisquer dúvidas oriundas do presente Termo.');

  // Fecho + local/data
  drawParagrafo(doc, 'Para firmeza e validade do que foi pactuado, lavra-se o presente instrumento em 3 (três) vias de igual teor e forma, para que surtam um só efeito, as quais, depois de lidas, são assinadas pelos representantes das partes, PERMITENTE e PERMISSIONÁRIO(A) e pelas testemunhas abaixo.');
  drawParagrafo(doc, `${cidadeUfDefault}, ${fmtDataExtenso(new Date().toISOString())}.`);

  // Assinaturas
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const linha = (rotulo) => {
    doc.moveDown(3);
    const y0 = doc.y;
    doc.moveTo(doc.page.margins.left, y0).lineTo(doc.page.margins.left + largura, y0).stroke();
    doc.moveDown(0.2);
    doc.font('Times-Roman').fontSize(11).text(rotulo, { width: largura, align: 'center' });
  };
  linha('PERMITENTE');
  linha('PERMISSIONÁRIA');
  linha('TESTEMUNHA – CPF Nº');
  linha('TESTEMUNHA – CPF Nº');

  // Paginação (apenas rodapé “Página X de Y”, sem reescrever cabeçalho aqui para não sobrepor conteúdo)
  const range = doc.bufferedPageRange(); // { start, count }
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    doc.font('Times-Roman').fontSize(9).fillColor('#333')
      .text(`Página ${i + 1} de ${range.count}`, right - 120, bottom + 6, { width: 120, align: 'right' });
  }

  doc.end();
  await new Promise((resolve, reject) => ws.on('finish', resolve).on('error', reject));

  // 6) Indexa/UPSERT em `documentos`
  await ensureDocumentosSchema();
  const publicUrl = `/documentos/${fileName}`;
  const createdAt = new Date().toISOString();
  await dbRun(
    `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url, status, created_at)
     VALUES ('termo_evento', NULL, NULL, ?, ?, ?, 'gerado', ?)
     ON CONFLICT(evento_id, tipo) DO UPDATE SET
       pdf_url = excluded.pdf_url,
       pdf_public_url = excluded.pdf_public_url,
       status = 'gerado',
       created_at = excluded.created_at`,
    [eventoId, filePath, publicUrl, createdAt],
    'termo/upsert'
  );

  return {
    documentoId: await dbGet(`SELECT id FROM documentos WHERE evento_id = ? AND tipo = 'termo_evento' ORDER BY id DESC LIMIT 1`, [eventoId]).then(r => r?.id),
    filePath,
    fileName,
    pdf_public_url: publicUrl,
    urlTermoPublic: publicUrl,
  };
}

module.exports = { gerarTermoEventoPdfkitEIndexar };
