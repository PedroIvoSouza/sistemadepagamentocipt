// src/services/termoEventoPdfkitService.js
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sqlite3 = require('sqlite3').verbose();

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

/* ================== Helpers de BD (promessas + log) ================== */
const dbGet = (sql, p = [], ctx = '') => new Promise((resolve, reject) => {
  console.log('[SQL][GET]', ctx, '\n ', sql, '\n ', 'params:', p);
  db.get(sql, p, (err, row) => err ? (console.error('[SQL][GET][ERRO]', ctx, err.message), reject(err)) : resolve(row));
});
const dbAll = (sql, p = [], ctx = '') => new Promise((resolve, reject) => {
  console.log('[SQL][ALL]', ctx, '\n ', sql, '\n ', 'params:', p);
  db.all(sql, p, (err, rows) => err ? (console.error('[SQL][ALL][ERRO]', ctx, err.message), reject(err)) : resolve(rows));
});
const dbRun = (sql, p = [], ctx = '') => new Promise((resolve, reject) => {
  console.log('[SQL][RUN]', ctx, '\n ', sql, '\n ', 'params:', p);
  db.run(sql, p, function (err) {
    if (err) { console.error('[SQL][RUN][ERRO]', ctx, err.message); reject(err); }
    else { resolve(this); }
  });
});

/* ================== Utils ================== */
const cm = (n) => n * 28.3464567; // 1 cm em pt
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
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
const sanitizeForFilename = (s = '') =>
  String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]+/g, '_')
    .replace(/["'`]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

// Normaliza espacos_utilizados que podem vir como JSON ou CSV
function parseEspacos(v) {
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

/* ================== Schema: documentos ================== */
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

/* ================== Blocos de desenho ================== */
function titulo3Linhas(doc, orgUF, orgSec, orgUni) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const opts = { width: largura, align: 'center' };
  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  doc.text((orgUF || 'ESTADO DE ALAGOAS').toUpperCase(), opts);
  doc.text((orgSec || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO').toUpperCase(), opts);
  doc.text((orgUni || 'CENTRO DE INOVAÇÃO DO JARAGUÁ').toUpperCase(), opts);
  doc.moveDown(0.8);
}

function paragrafoAberturaComRecuo(doc, texto) {
  // recuo de 6cm apenas neste parágrafo
  const leftBase = doc.page.margins.left;
  const topNow = doc.y;
  const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = leftBase + cm(6);
  const largura = larguraUtil - cm(6);

  doc.font('Times-Bold').fontSize(12).fillColor('#000');
  doc.text(texto, left, topNow, { width: largura, align: 'justify' });

  // reset âncora para os próximos parágrafos
  doc.x = leftBase;
  doc.moveDown(1);
}

function paragrafo(doc, texto) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12).fillColor('#000')
     .text(texto, doc.page.margins.left, doc.y, { width: largura, align: 'justify' });
  doc.moveDown(0.6);
}

function tituloClausula(doc, titulo) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.5);
  doc.font('Times-Bold').fontSize(12).fillColor('#000')
     .text(titulo.toUpperCase(), doc.page.margins.left, doc.y, { width: largura, align: 'left' });
}

function linhaInfo(doc, rotulo, valor) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12).fillColor('#000')
     .text(`${rotulo} ${valor}`, doc.page.margins.left, doc.y, { width: largura, align: 'left' });
}

function tabelaDiscriminacao(doc, dados) {
  const left   = doc.page.margins.left;
  const right  = doc.page.width - doc.page.margins.right;
  const top    = doc.y; // usa a posição atual
  const bottom = doc.page.height - doc.page.margins.bottom;

  const largura = right - left;
  const pad = { x: 6, y: 6 };

  const cols = [
    { w: largura * 0.47, label: 'Discriminação / Área utilizada', align: 'left',  font: 'Times-Roman' },
    { w: largura * 0.18, label: 'Área (m²) / Capacidade',         align: 'left',  font: 'Times-Roman' },
    { w: largura * 0.15, label: 'Nº de dias',                     align: 'center',font: 'Times-Roman' },
    { w: largura * 0.20, label: 'Valor total',                    align: 'right', font: 'Times-Roman' },
  ];

  let x = left;
  let y = top;

  const drawHeader = () => {
    x = left;
    doc.font('Times-Bold').fontSize(11);
    // calcula a altura necessária de cada cabeçalho dentro da largura da coluna
    const heights = cols.map((c) =>
      doc.heightOfString(c.label, { width: c.w - pad.x * 2, align: c.align })
    );
    const rowH = Math.max(...heights) + pad.y * 2;

    // se não couber, vai pra próxima página
    if (y + rowH > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      x = left;
    }

    // desenha as células do cabeçalho
    cols.forEach((c, i) => {
      doc.rect(x, y, c.w, rowH).stroke('#000');
      doc.text(c.label, x + pad.x, y + pad.y, {
        width: c.w - pad.x * 2,
        align: c.align
      });
      x += c.w;
    });

    y += rowH; // próxima linha
  };

  const drawRow = (cells) => {
    x = left;
    doc.font('Times-Roman').fontSize(11);

    // calcula alturas necessárias por coluna
    const heights = cells.map((txt, i) =>
      doc.heightOfString(String(txt), {
        width: cols[i].w - pad.x * 2,
        align: cols[i].align
      })
    );
    const rowH = Math.max(...heights) + pad.y * 2;

    // quebra de página segura (reimprime cabeçalho)
    if (y + rowH > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }

    // desenha células
    cells.forEach((txt, i) => {
      const c = cols[i];
      doc.rect(x, y, c.w, rowH).stroke('#000');
      doc.text(String(txt), x + pad.x, y + pad.y, {
        width: c.w - pad.x * 2,
        align: c.align
      });
      x += c.w;
    });

    y += rowH;
  };

  // --- imprime ---
  drawHeader();

  const col1 = [
    `${dados.discriminacao}`,
    `Realização: ${dados.realizacao}`,
    `Montagem: ${dados.montagem}`,
    `Desmontagem: ${dados.desmontagem}`,
  ].join('\n');

  const col2 = `${dados.area} (capacidade para ${dados.capacidade} pessoas)`;
  const col3 = String(dados.dias);
  const col4 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
               .format(Number(dados.valor || 0));

  drawRow([col1, col2, col3, col4]);

  // avança um espacinho após a tabela
  doc.y = y + 8;
}


function assinaturasKeepTogether(doc, rotulos = ['PERMITENTE', 'PERMISSIONÁRIA', 'TESTEMUNHA – CPF Nº', 'TESTEMUNHA – CPF Nº']) {
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;

  // estimativa de altura necessária (linha + rótulo) * 4
  const hRot = doc.heightOfString('X', { width: largura, align: 'center' });
  const hCada = 40 + 4 + hRot + 10; // 40pt de “linha”, uns respiros
  const alturaTotal = hCada * rotulos.length;

  const yMax = doc.page.height - doc.page.margins.bottom;
  if (doc.y + alturaTotal > yMax) {
    doc.addPage();
  }

  doc.font('Times-Roman').fontSize(11);

  rotulos.forEach(rotulo => {
    doc.moveDown(3);
    const y0 = doc.y;
    doc.moveTo(left, y0).lineTo(left + largura, y0).stroke('#000');
    doc.moveDown(0.2);
    doc.text(rotulo, left, doc.y, { width: largura, align: 'center' });
  });
}

/* ================== Função principal ================== */
async function gerarTermoEventoPdfkitEIndexar(eventoId) {
  console.log('[TERMO][SERVICE] gerarTermoEventoPdfkitEIndexar para evento', eventoId);
  await ensureDocumentosSchema();

  // 1) Evento + Cliente
  const ev = await dbGet(
    `SELECT e.*,
            c.nome_razao_social,
            c.documento,
            c.endereco,
            c.cep,
            c.nome_responsavel,
            c.documento_responsavel
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [eventoId],
    'termo/get-evento'
  );
  if (!ev) throw new Error('Evento não encontrado');

  // 2) Parcelas (para datas do 50% e saldo)
  const parcelas = await dbAll(
    `SELECT de.numero_parcela, de.valor_parcela, de.data_vencimento, d.status
       FROM DARs_Eventos de
       JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ?
      ORDER BY de.numero_parcela ASC`,
    [eventoId],
    'termo/get-parcelas'
  );
  const sinalISO = parcelas[0]?.data_vencimento || null;
  const saldoISO = parcelas[1]?.data_vencimento || parcelas[0]?.data_vencimento || null;

  // 3) Placeholders/env
  const orgUF  = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
  const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
  const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

  const permitenteRazao = process.env.PERMITENTE_RAZAO
    || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
  const permitenteCnpj  = process.env.PERMITENTE_CNPJ  || '04.007.216/0001-30';
  const permitenteEnd   = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
  const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SÍLVIO ROMERO BULHÕES AZEVEDO';
  const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
  const permitenteRepCpf= process.env.PERMITENTE_REP_CPF || '053.549.204-93';

  let datasArr = [];
  try {
    if (typeof ev.datas_evento === 'string') {
      datasArr = ev.datas_evento.trim().startsWith('[')
        ? JSON.parse(ev.datas_evento)
        : ev.datas_evento.split(',').map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(ev.datas_evento)) {
      datasArr = ev.datas_evento;
    }
  } catch { /* noop */ }
  const primeiraDataISO = datasArr[0] || '';
  const dataEventoExt   = fmtDataExtenso(primeiraDataISO) || '-';

  const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
  const fundoNome = process.env.FUNDO_NOME || 'FUNDECTES';
  const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
  const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;
  const localEspaco = parseEspacos(ev.espaco_utilizado).join(', ') || 'AUDITÓRIO';

  // 4) Arquivo de saída
  const publicDir = path.join(process.cwd(), 'public', 'documentos');
  fs.mkdirSync(publicDir, { recursive: true });
  const fileName = sanitizeForFilename(
    `TermoPermissao_${String(ev.numero_termo || 's-n').replace(/[\/\\]/g, '-')}_${(ev.nome_razao_social || 'Cliente')}_${(primeiraDataISO || 's-d')}.pdf`
  );
  const filePath = path.join(publicDir, fileName);

  // 5) PDF: sem bufferPages (sem paginação pós-processamento)
  const doc = new PDFDocument({ size: 'A4', margins: abntMargins(0.5, 0.5) });
  const ws = fs.createWriteStream(filePath);
  doc.pipe(ws);

  // Timbrado (como no ofício): tenta public/images, senão assets
  let letterheadPath = path.join(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png');
  if (!fs.existsSync(letterheadPath)) {
    letterheadPath = path.join(__dirname, '..', 'assets', 'papel-timbrado-secti.png');
  }
  applyLetterhead(doc, { imagePath: letterheadPath });

  // Cursor inicial
  doc.font('Times-Roman').fontSize(12);
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;

  // Cabeçalho (3 linhas)
  titulo3Linhas(doc, orgUF, orgSec, orgUni);

  // Abertura com recuo de 6 cm APENAS aqui
  const abertura = `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO A ${permitenteRazao} E DO OUTRO ${(ev.nome_razao_social || '').toUpperCase()}.`;
  paragrafoAberturaComRecuo(doc, abertura);

  // Processo / Termo (já justificado normal, sem recuo)
  linhaInfo(doc, 'Processo n°:', ev.numero_processo || '');
  linhaInfo(doc, 'Termo n°:', ev.numero_termo || '');
  doc.moveDown(0.6);

  // Partes
  paragrafo(doc,
    `PERMITENTE: ${permitenteRazao}, inscrita no CNPJ/MF sob o nº ${permitenteCnpj} e estabelecida no endereço ${permitenteEnd}, de acordo com a representação legal que lhe é outorgada por portaria e representada pelo responsável: ${permitenteRepCg}, Sr(a). ${permitenteRepNm}, inscrito(a) no CPF sob o nº ${permitenteRepCpf}.`
  );
  paragrafo(doc,
    `PERMISSIONÁRIO(A): ${ev.nome_razao_social || ''}, inscrito(a) no CPF/CNPJ sob o nº ${onlyDigits(ev.documento || '')}, estabelecido(a) em ${ev.endereco || '-'}, representado por ${ev.nome_responsavel || '-'}, CPF nº ${onlyDigits(ev.documento_responsavel || '')}.`
  );

  // CLÁUSULA 1
  tituloClausula(doc, 'Cláusula Primeira – Do Objeto');
  paragrafo(doc,
    `1.1 - O presente instrumento tem como objeto o uso pelo(a) PERMISSIONÁRIO(A) de área do ${localEspaco} do imóvel denominado ${imovelNome}, para realização de “${ev.nome_evento || ''}”, a ser realizada em ${dataEventoExt}, das ${ev.hora_inicio || '-'} às ${ev.hora_fim || '-'}, devendo a montagem ser realizada no mesmo dia do evento e a desmontagem ao final, conforme proposta em anexo, estando disponível o uso do seguinte espaço:`
  );

  // Tabela
  tabelaDiscriminacao(doc, {
    discriminacao: `${localEspaco} do ${imovelNome}`,
    realizacao: dataEventoExt || '-',
    montagem: fmtDataExtenso(primeiraDataISO) || '-',
    desmontagem: fmtDataExtenso(primeiraDataISO) || '-',
    area: fmtArea(ev.area_m2),
    capacidade: capDefault,
    dias: ev.total_diarias || (datasArr.length || 1),
    valor: ev.valor_final || 0,
  });

  if (ev.remarcado) {
    let origArr = [];
    try {
      if (typeof ev.datas_evento_original === 'string') {
        origArr = ev.datas_evento_original.trim().startsWith('[')
          ? JSON.parse(ev.datas_evento_original)
          : ev.datas_evento_original.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(ev.datas_evento_original)) {
        origArr = ev.datas_evento_original;
      }
    } catch { /* noop */ }
    const novaStr = datasArr.map(fmtDataExtenso).join(', ');
    const origStr = origArr.map(fmtDataExtenso).join(', ');
    const pedidoStr = fmtDataExtenso(ev.data_pedido_remarcacao);
    const aprovadoStr = fmtDataExtenso(ev.data_aprovacao_remarcacao);
    let clausula = `Parágrafo Único - Evento remarcado. Data original: ${origStr || '-'}`;
    clausula += `; pedido em: ${pedidoStr || '-'}`;
    if (ev.data_aprovacao_remarcacao) {
      clausula += `; aprovado em: ${aprovadoStr || '-'}`;
    }
    clausula += `; nova data: ${novaStr || '-'}.`;
    paragrafo(doc, clausula);
  }

  // CLÁUSULA 2 – (texto inteiro em uma única chamada, sem quebras manuais)
  tituloClausula(doc, 'Cláusula Segunda – Da Vigência');
  paragrafo(doc,
    `2.1 - O prazo de vigência se inicia na data de assinatura do presente termo até ${ev.data_vigencia_final ? new Date(ev.data_vigencia_final).toLocaleDateString('pt-BR') : '-'} às 12h.`
  );

  // CLÁUSULA 3 – Pagamento
  tituloClausula(doc, 'Cláusula Terceira – Do Pagamento');
  paragrafo(doc,
    `3.1 - O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${fmtMoeda(ev.valor_final || 0)}, através de Documento de Arrecadação – DAR, efetuado em favor da conta do Fundo Estadual de Desenvolvimento Científico, Tecnológico e de Educação Superior (${fundoNome}), devendo ser pago o valor de 50% até ${fmtDataExtenso(sinalISO)} e o restante até ${fmtDataExtenso(saldoISO)}.`
  );
  paragrafo(doc, '3.1.1. Fica incluso ao valor estabelecido no item anterior o pagamento relativo somente ao consumo de água, esgoto e energia elétrica.');
  paragrafo(doc, '3.1.2. Após o pagamento a data estará reservada, de modo que não haverá devolução de qualquer valor pago em caso de desistência.');
  paragrafo(doc, '3.1.3. No caso de não haver a quitação total do valor, a reserva estará desfeita.');

  // CLÁUSULA 4 – PermITENTE
  tituloClausula(doc, 'Cláusula Quarta – Das Obrigações do Permitente');
  paragrafo(doc, '4.1 - Ceder o espaço, na data e hora acordadas, entregando o local em perfeitas condições de higiene, limpeza e conservação.');
  paragrafo(doc, '4.2 - Fiscalizar, por meio do gestor indicado pela SECTI, a utilização do espaço objeto deste termo de permissão, podendo impedir a utilização inadequada do espaço cedido evitando assim danos ao patrimônio do objeto do presente termo de permissão.');
  paragrafo(doc,
    'Parágrafo Único - Os espaços físicos disponíveis são as áreas do auditório do Centro de Inovação do Jaraguá destinada à realização de eventos, compreendendo o espaço de 429,78 m² (banheiro masculino e feminino, 02 salas de tradução, 09 espaços destinados a cadeirantes, palco - com acesso externo -, 02 coxias, 02 camarins, 01 copa e 01 área técnica), do espaço aberto em frente ao auditório, não incluindo as baias e nem o coworking público, não sendo permitida apresentação musical fora do auditório, bem como não é permitido servir alimentos/bebidas dentro do auditório, de modo que qualquer violação destas será cobrada uma multa no valor de 10% do valor de locação.'
  );

  // CLÁUSULA 5 – Permissionária
  // CORREÇÃO: Adicionadas vírgulas entre os itens do array.
  tituloClausula(doc, 'Cláusula Quinta – Das Obrigações da Permissionária');
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
    '5.15 - - O permissionário deve enviar a documentação para verificar a necessidade de gerador externo para o e-mail supcti@secti.al.gov.br em até 5 dias após o envio do termo de permissão de uso para assinatura.',
    '5.16 - Toda estrutura que não for retirada no dia da desmontagem que consta neste termo de permissão de uso será destinada a outros fins, bem como será aplicada multa no valor de 10% da locação.',
    '5.17 - É vedada a utilização da porta de emergência para fins que não seja de segurança, tais como movimentação de estrutura de eventos, sob pena de multa em caso de desobediência.',
    '5.18 - É proibido o consumo de comidas/bebidas dentro do auditório ou do anfiteatro, de modo que havendo violação deverá ser aplicada multa de 10% do valor de locação, bem como deverá arcar com o valor de danos, caso tenha ocorrido.',
    '5.19 - É proibido som e/ou apresentação musical fora do auditório, sob pena de multa.',
    '5.20 - Não é permitido colocar qualquer estrutura no carpete, tanto do auditório quanto do anfiteatro.',
    '5.21 - Não é permitido desligar as tomadas das baias.',
    '5.22 - Deverão constar as logomarcas da SECTI e do CIPT nos materiais de divulgação do evento.',
    '5.23 - Somente serão considerados válidos os procedimentos, condições ou benefícios expressamente previstos neste Termo. Qualquer exceção às disposições aqui estabelecidas deverá ser formalmente requerida junto à esta Secretaria responsável, por meio de solicitação oficial e devidamente fundamentada, ficando sua concessão condicionada à análise e autorização expressa da referida Secretaria, a seu exclusivo critério.',
    '5.24 - O Permissionário deve enviar o termo de permissão de uso devidamente assinado no prazo de até 5 (cinco) dias contados da data do envio do documento, sob pena de CANCELAMENTO da reserva da data, sem devolução de qualquer valor pago.'
  ].forEach(p => paragrafo(doc, p));

  // CLÁUSULA 6 – Penalidades
  // CORREÇÃO: Adicionadas vírgulas entre os itens do array.
  tituloClausula(doc, 'Cláusula Sexta – Das Penalidades');
  [
    '6.1 - O descumprimento das cláusulas ora pactuadas por qualquer das partes acarretará a incidência de multa equivalente a 10% (dez por cento) do valor da permissão, a ser paga pela parte que deu causa em favor da parte inocente.',
    '6.2 - O valor descrito no item anterior deverá ser corrigido com base no IPCA do período correspondente, montante sobre o qual incidirão juros moratórios de 1% (um por cento) ao mês, calculado pro rata die.',
    '6.3 - Na hipótese de rescisão ocasionada pelo(a) PERMISSIONÁRIO(A) por desistência ou cancelamento do evento até os 30 (trinta) dias de antecedência o permissionário deverá ser penalizado com a perda da taxa de reserva mais multa de 20% (vinte por cento) sobre o valor do presente termo.',
    '6.4 - Em caso de violação das normas previstas neste contrato e no regimento interno, e havendo inadimplemento da multa aplicada e/ou ausência de manifestação por parte do permissionário, este poderá ser impedido de realizar reservas dos espaços por até 2 (dois) anos, contados a partir da data da notificação.',
    '6.5. No caso de reincidência das infrações cometidas, o permissionário ficará impedido de realizar os espaços por 2 (dois) anos.'
  ].forEach(p => paragrafo(doc, p));

  // CLÁUSULA 7 – Rescisão
  // CORREÇÃO: Adicionadas vírgulas entre os itens do array.
  tituloClausula(doc, 'Cláusula Sétima – Da Rescisão');
  [
    '7.1 - A inexecução total ou parcial deste termo poderá acarretar em sanções administrativas, conforme disposto nos artigos 104, 137, 138 e 139 da Lei nº 14.133/2021.',
    '7.2 - Este instrumento poderá ser rescindido a qualquer tempo pelo(a) Permissionário(a), mediante notificação prévia, devidamente protocolada na Secretaria de Estado da Ciência, da Tecnologia e da Inovação de Alagoas – SECTI, com antecedência mínima de 30 (trinta) dias da data prevista para o evento mediante justificativa. Nessa hipótese, o Permissionário terá o prazo de até 1 (um) ano para realizar o evento em nova data, contado a partir da data da abertura do processo administrativo, e desde que haja disponibilidade de agenda. Caso contrário, perderá integralmente os valores já pagos.',
    '7.3 - A nova data a ser agendada deverá ser informada no prazo máximo de 30 (trinta) dias corridos, contados a partir da comunicação do cancelamento.',
    '7.4 -  A remarcação do evento será permitida uma única vez. O não cumprimento do prazo para indicação da nova data acarretará a perda do direito à remarcação, sem qualquer restituição dos valores pagos.',
    '7.5 - Ocorrerá a rescisão do presente termo de permissão, independente de qualquer comunicação prévia ou indenização por parte da PERMITENTE, havendo qualquer sinistro, incêndio ou algo que venha impossibilitar a posse do espaço, independente de dolo ou culpa do PERMITENTE.'
  ].forEach(p => paragrafo(doc, p));

  // CLÁUSULA 8 – Omissões
  tituloClausula(doc, 'Cláusula Oitava – Omissões Contratuais');
  paragrafo(doc, '8.1 - Os casos omissos serão decididos pela PERMITENTE segundo as disposições contidas na Lei nº 14.133/2021, e nas demais normas de licitações e contratos administrativos, além de, subsidiariamente, as disposições contidas na Lei nº 8.078/90 – Código de Defesa do Consumidor, e normas e princípios gerais dos contratos.');

  // CLÁUSULA 9 – Foro
  tituloClausula(doc, 'Cláusula Nona – Do Foro');
  paragrafo(doc, '9.1 - As questões decorrentes da execução deste Instrumento que não possam ser dirimidas administrativamente serão processadas e julgadas no Foro da Cidade de Maceió – AL, que prevalecerá sobre qualquer outro, por mais privilegiado que seja, para dirimir quaisquer dúvidas oriundas do presente Termo.');

  // Fecho + Data/local
  paragrafo(doc, 'Para firmeza e validade do que foi pactuado, lavra-se o presente instrumento em 3 (três) vias de igual teor e forma, para que surtam um só efeito, as quais, depois de lidas, são assinadas pelos representantes das partes, PERMITENTE e PERMISSIONÁRIO(A) e pelas testemunhas abaixo.');
  paragrafo(doc, `${cidadeUfDefault}, ${fmtDataExtenso(new Date().toISOString())}.`);

  // Assinaturas (mantém o bloco junto)
  assinaturasKeepTogether(doc);

  // Finaliza
  const finishPromise = new Promise((resolve, reject) => {
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  doc.end();
  await finishPromise;
  console.log('[TERMO][SERVICE] PDF gravado em', filePath);

  // 6) Indexa (UPSERT por evento+tipo)
  const createdAt = new Date().toISOString();
  const publicUrl = `/documentos/${fileName}`;
  await dbRun(
    `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, pdf_url, pdf_public_url, status, created_at)
     VALUES ('termo_evento', NULL, NULL, ?, ?, ?, 'gerado', ?)
     ON CONFLICT(evento_id, tipo) DO UPDATE SET
       pdf_url = excluded.pdf_url,
       pdf_public_url = excluded.pdf_public_url,
       status = 'gerado',
       created_at = excluded.created_at`,
    [eventoId, filePath, publicUrl, createdAt],
    'termo/upsert-documento'
  );

  return { filePath, fileName, pdf_public_url: publicUrl };
}

module.exports = { gerarTermoEventoPdfkitEIndexar };
