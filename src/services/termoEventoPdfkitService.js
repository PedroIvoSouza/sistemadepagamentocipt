const VERSION = 'pdfkit-v3';
console.log(`[TERMO][SERVICE] carregado ${VERSION} de`, __filename);

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sqlite3 = require('sqlite3').verbose();

const { applyLetterhead, abntMargins } = require('../utils/pdfLetterhead');

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_STORAGE || './sistemacipt.db');
const db = new sqlite3.Database(DB_PATH);

// ---------- helpers sqlite (promessas) ----------
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

// ---------- utils ----------
const cm = (n) => n * 28.3464567; // 1cm em pt
const onlyDigits = (v = '') => String(v).replace(/\D/g, '');
const sanitize = (s = '') => String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/\\]/g, '_').replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');

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

// --------- MIGRAÇÃO DA TABELA `documentos` (auto) ---------
async function ensureDocumentosSchema() {
    await dbRun(`CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    token TEXT UNIQUE
  )`);

    const cols = await dbAll(`PRAGMA table_info(documentos)`);
    const names = new Set(cols.map(c => c.name));
    const addIfMissing = async (name, def) => {
        if (!names.has(name)) {
            await dbRun(`ALTER TABLE documentos ADD COLUMN ${name} ${def}`);
            names.add(name);
        }
    };

    await addIfMissing('permissionario_id', 'INTEGER');
    await addIfMissing('evento_id', 'INTEGER');
    await addIfMissing('pdf_url', 'TEXT');
    await addIfMissing('pdf_public_url', 'TEXT');
    await addIfMissing('assinafy_id', 'TEXT');
    await addIfMissing('status', "TEXT DEFAULT 'gerado'");
    await addIfMissing('signed_pdf_public_url', 'TEXT');
    await addIfMissing('signed_at', 'TEXT');
    await addIfMissing('signer', 'TEXT');
    await addIfMissing('created_at', 'TEXT');

    try {
        await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_documentos_evento_tipo ON documentos(evento_id, tipo)`);
    } catch (e) { }
}

// ---------- carga de dados do Evento -> payload ----------
async function buildPayloadFromEvento(eventoId) {
    const ev = await dbGet(
        `SELECT e.*, c.nome_razao_social, c.tipo_pessoa, c.documento, c.email, c.telefone, c.endereco,
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

    const datasArr = String(ev.datas_evento || '').split(',').map(s => s.trim()).filter(Boolean);
    const primeiraData = datasArr[0] || new Date().toISOString().split('T')[0];

    // Variáveis do .env ou padrão
    const capDefault = process.env.CAPACIDADE_PADRAO ? Number(process.env.CAPACIDADE_PADRAO) : 313;
    const cidadeUfDefault = process.env.CIDADE_UF || 'Maceió/AL';
    const fundoNome = process.env.FUNDO_NOME || 'FUNDENTES';
    const imovelNome = process.env.IMOVEL_NOME || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';
    const permitenteRazao = process.env.PERMITENTE_RAZAO || 'SECRETARIA DE ESTADO DA CIÊNCIA, DA TECNOLOGIA E DA INOVAÇÃO DE ALAGOAS - SECTI';
    const permitenteCnpj = process.env.PERMITENTE_CNPJ || '04.007.216/0001-30';
    const permitenteEnd = process.env.PERMITENTE_ENDERECO || 'R. BARÃO DE JARAGUÁ, Nº 590, JARAGUÁ, MACEIÓ - ALAGOAS - CEP: 57022-140';
    const permitenteRepNm = process.env.PERMITENTE_REP_NOME || 'SILVIO ROMERO BULHÕES AZEVEDO';
    const permitenteRepCg = process.env.PERMITENTE_REP_CARGO || 'SECRETÁRIO';
    const permitenteRepCpf = process.env.PERMITENTE_REP_CPF || '053.549.204-93';
    const orgUF = process.env.ORG_UF || 'ESTADO DE ALAGOAS';
    const orgSec = process.env.ORG_SECRETARIA || 'SECRETARIA DA CIÊNCIA, TECNOLOGIA E INOVAÇÃO';
    const orgUni = process.env.ORG_UNIDADE || 'CENTRO DE INOVAÇÃO DO JARAGUÁ';

    const sinal = parcelas.find(p => p.numero_parcela === 1)?.data_vencimento || null;
    const saldo = parcelas.find(p => p.numero_parcela === 2)?.data_vencimento || sinal;

    // Lógica para data de vigência final: dia do evento + 1 dia
    let vigenciaFinal;
    if (datasArr.length > 0) {
        const ultimaDataEvento = new Date(datasArr[datasArr.length - 1] + 'T00:00:00');
        ultimaDataEvento.setDate(ultimaDataEvento.getDate() + 1);
        vigenciaFinal = ultimaDataEvento.toLocaleDateString('pt-BR');
    } else {
        vigenciaFinal = 'N/A';
    }


    return {
        org_uf: orgUF,
        org_secretaria: orgSec,
        org_unidade: orgUni,
        processo_numero: ev.numero_processo || '',
        termo_numero: ev.numero_termo || '',
        permitente_razao: permitenteRazao,
        permitente_cnpj: permitenteCnpj,
        permitente_endereco: permitenteEnd,
        permitente_representante_nome: permitenteRepNm,
        permitente_representante_cargo: permitenteRepCg,
        permitente_representante_cpf: permitenteRepCpf,
        permissionario_razao: ev.nome_razao_social || '',
        permissionario_cnpj: onlyDigits(ev.documento || ''),
        permissionario_endereco: ev.endereco || '',
        permissionario_representante_nome: ev.nome_responsavel || '',
        permissionario_representante_cpf: onlyDigits(ev.documento_responsavel || ''),
        evento_titulo: ev.nome_evento || '',
        local_espaco: ev.espaco_utilizado || 'AUDITÓRIO',
        imovel_nome: imovelNome,
        data_evento: fmtDataExtenso(primeiraData),
        hora_inicio: ev.hora_inicio || '-',
        hora_fim: ev.hora_fim || '-',
        data_montagem: fmtDataExtenso(primeiraData),
        data_desmontagem: fmtDataExtenso(primeiraData),
        area_m2: ev.area_m2 || 0,
        area_m2_fmt: fmtArea(ev.area_m2),
        capacidade_pessoas: capDefault,
        numero_dias: ev.total_diarias || (datasArr.length || 1),
        valor_total: ev.valor_final || 0,
        valor_total_fmt: fmtMoeda(ev.valor_final || 0),
        vigencia_fim_datahora: `${vigenciaFinal} às 12h`,
        pagto_sinal_data: fmtDataExtenso(sinal),
        pagto_saldo_data: fmtDataExtenso(saldo),
        fundo_nome: fundoNome,
        cidade_uf: cidadeUfDefault,
        data_assinatura: fmtDataExtenso(new Date().toISOString()),
        _raw: ev
    };
}


// ---------- helpers de escrita ----------
function textJustify(doc, str, opts = {}) {
    doc.text(str, {
        align: 'justify',
        lineGap: 2.8, // Aproximação para espaçamento 1.15
        ...opts
    });
    if (opts.spaceAfter) doc.moveDown(opts.spaceAfter);
}

function headingClausula(doc, titulo) {
    doc.moveDown(0.8);
    doc.font('Times-Bold').text(titulo.toUpperCase());
    doc.moveDown(0.3);
    doc.font('Times-Roman');
}

function drawDiscriminacaoTable(doc, payload) {
    doc.moveDown(1);
    const tableTop = doc.y;
    const left = doc.page.margins.left;
    const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const table = {
        headers: ['Discriminação / Área utilizada', 'Área (m²) / Capacidade', 'Nº de dias', 'Valor total'],
        colWidths: [larguraUtil * 0.45, larguraUtil * 0.25, larguraUtil * 0.1, larguraUtil * 0.2],
        rows: [
            [
                `${payload.local_espaco} do ${payload.imovel_nome}\nRealização: ${payload.data_evento}\nMontagem: ${payload.data_montagem}\nDesmontagem: ${payload.data_desmontagem}`,
                `${payload.area_m2_fmt} (capacidade para ${payload.capacidade_pessoas} pessoas)`,
                payload.numero_dias,
                payload.valor_total_fmt
            ]
        ]
    };

    // Função para desenhar a linha
    function drawRow(row, y, isHeader = false) {
        let x = left;
        let maxHeight = 0;

        // Calcula a altura da linha
        row.forEach((cell, i) => {
            const cellHeight = doc.heightOfString(cell, { width: table.colWidths[i] - 10 });
            if (cellHeight > maxHeight) {
                maxHeight = cellHeight;
            }
        });
        maxHeight += 10; // padding

        // Desenha as células
        row.forEach((cell, i) => {
            doc.rect(x, y, table.colWidths[i], maxHeight).stroke();
            doc.font(isHeader ? 'Times-Bold' : 'Times-Roman').fontSize(isHeader ? 11 : 10)
                .text(cell, x + 5, y + 5, { width: table.colWidths[i] - 10 });
            x += table.colWidths[i];
        });
        return maxHeight;
    }

    // Desenha o cabeçalho e as linhas
    let y = tableTop;
    const headerHeight = drawRow(table.headers, y, true);
    y += headerHeight;

    table.rows.forEach(row => {
        const rowHeight = drawRow(row, y);
        y += rowHeight;
    });

    doc.y = y;
    doc.moveDown(1);
}


// ---------- salva arquivo + upsert em documentos ----------
async function salvarRegistro(buffer, tipo, eventoId, evRow) {
    await ensureDocumentosSchema();

    const dir = path.resolve(process.cwd(), 'public', 'documentos');
    fs.mkdirSync(dir, { recursive: true });

    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const createdAt = new Date().toISOString();

    await dbRun(
        `INSERT INTO documentos (tipo, token, permissionario_id, evento_id, status, created_at)
       VALUES (?, ?, NULL, ?, 'gerado', ?)
       ON CONFLICT(evento_id, tipo) DO UPDATE SET
         token=excluded.token, status='gerado', created_at=excluded.created_at`,
        [tipo, token, eventoId || null, createdAt]
    );

    const row = await dbGet(`SELECT id FROM documentos WHERE evento_id=? AND tipo=? ORDER BY id DESC LIMIT 1`, [eventoId, tipo]);
    const documentoId = row?.id;

    const termoSan = sanitize(evRow?.numero_termo || 's_n');
    const razaoSan = sanitize(evRow?.nome_razao_social || 'Cliente');
    const dataPrimeira = (String(evRow?.datas_evento || '').split(',')[0] || '').trim() || 's_d';
    const fileName = `TermoPermissao_${termoSan}_${razaoSan}_Data-${dataPrimeira}_${documentoId}.pdf`;

    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/documentos/${fileName}`;
    await dbRun(`UPDATE documentos SET pdf_url=?, pdf_public_url=? WHERE id=?`, [filePath, publicUrl, documentoId]);

    return { documentoId, token, filePath, fileName, pdf_public_url: publicUrl };
}

function findLetterheadPath() {
    const candidates = [
        path.resolve(process.cwd(), 'public', 'images', 'papel-timbrado-secti.png'),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
}

// ---------- Geração do PDF (PDFKit, timbrado, header/footer) ----------
async function gerarTermoEventoPdfEIndexar(eventoId, { returnBuffer = false } = {}) {
    console.log(`[TERMO][SERVICE] gerarTermoEventoPdfkitEIndexar(${eventoId}) - ${VERSION}`);
    const payload = await buildPayloadFromEvento(eventoId);
    const evRow = payload._raw;

    const chunks = [];
    const margin = cm(2.5);
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: margin, bottom: margin, left: margin, right: margin },
        bufferPages: true // Necessário para o rodapé com número de páginas
    });

    const letterhead = findLetterheadPath();
    if (letterhead) applyLetterhead(doc, { imagePath: letterhead });

    doc.on('data', (d) => chunks.push(d));
    const endPromise = new Promise((res) => doc.on('end', res));

    // ======= CONTEÚDO =======
    doc.font('Times-Roman').fontSize(12).fillColor('black');

    // Cabeçalho
    doc.font('Times-Bold').text(payload.org_uf.toUpperCase(), { align: 'center' });
    doc.text(payload.org_secretaria.toUpperCase(), { align: 'center' });
    doc.text(payload.org_unidade.toUpperCase(), { align: 'center' });
    doc.moveDown(2);

    // Título do Documento
    doc.font('Times-Roman').text(
        `TERMO DE PERMISSÃO DE USO QUE CELEBRAM ENTRE SI DE UM LADO A ${payload.permitente_razao} E DO OUTRO ${payload.permissionario_razao}.`,
        { align: 'justify' }
    );
    doc.moveDown(1.5);

    // Processo e Termo
    doc.text(`Processo n°: ${payload.processo_numero}`);
    doc.text(`Termo n°: ${payload.termo_numero}`);
    doc.moveDown(1);

    // Partes
    textJustify(doc, `PERMITENTE: A ${payload.permitente_razao}, inscrita no CNPJ/MF sob o nº ${payload.permitente_cnpj} e estabelecido(a) no(a) ${payload.permitente_endereco}, de acordo com a representação legal que lhe é outorgada por portaria e representado pelo responsável: ${payload.permitente_representante_cargo}, Sr. ${payload.permitente_representante_nome}, inscrito no CPF sob o nº. ${payload.permitente_representante_cpf}.`, { spaceAfter: 0.5 });
    textJustify(doc, `PERMISSIONÁRIO(A): A ${payload.permissionario_razao}, inscrito(a) no CNPJ/MF sob o nº ${payload.permissionario_cnpj} e estabelecido(a) na ${payload.permissionario_endereco}, representado pela Sra. ${payload.permissionario_representante_nome}, inscrita no CPF sob o nº ${payload.permissionario_representante_cpf}.`, { spaceAfter: 0.5 });

    // --- CLÁUSULAS ---

    headingClausula(doc, 'CLÁUSULA PRIMEIRA: DO OBJETO');
    textJustify(doc, `1.1 - O presente instrumento tem como objeto o uso pelo(a) PERMISSIONÁRIO(A) de área do ${payload.local_espaco} do imóvel denominado ${payload.imovel_nome}, para realização da “${payload.evento_titulo}”, a ser realizada no dia ${payload.data_evento}, das ${payload.hora_inicio} às ${payload.hora_fim}, devendo a montagem ser realizada no mesmo dia do evento e a desmontagem ao final, conforme proposta em anexo, estando disponível o uso do seguinte espaço:`);
    drawDiscriminacaoTable(doc, payload);

    headingClausula(doc, 'CLÁUSULA SEGUNDA – DA VIGÊNCIA');
    textJustify(doc, `2.1 - O prazo de vigência se inicia na data de assinatura do presente termo até ${payload.vigencia_fim_datahora}.`);

    headingClausula(doc, 'CLÁUSULA TERCEIRA – DO PAGAMENTO');
    [
        `3.1 - O(A) PERMISSIONÁRIO(A) pagará pela utilização do espaço o valor total de ${payload.valor_total_fmt}, através de Documento de Arrecadação – DAR, efetuado em favor da conta do Fundo Estadual de Desenvolvimento Científico, Tecnológico e de Educação Superior (${payload.fundo_nome}), devendo ser pago o valor de 50% até o dia ${payload.pagto_sinal_data} e o restante até o dia ${payload.pagto_saldo_data}.`,
        `3.1.1. Fica incluso ao valor estabelecido no item anterior o pagamento relativo somente ao consumo de água, esgoto e energia elétrica.`,
        `3.1.2. Após o pagamento a data estará reservada, de modo que não haverá devolução de qualquer valor pago em caso de desistência.`,
        `3.1.3. No caso de não haver a quitação total do valor, a reserva estará desfeita.`
    ].forEach(p => textJustify(doc, p, { spaceAfter: 0.5 }));

    headingClausula(doc, 'CLÁUSULA QUARTA – DAS OBRIGAÇÕES DO PERMITENTE');
    [
        `4.1 - Ceder o espaço, na data e hora acordadas, entregando o local em perfeitas condições de higiene, limpeza e conservação.`,
        `4.2 - Fiscalizar, por meio do gestor indicado pela SECTI, a utilização do espaço objeto deste termo de permissão, podendo impedir a utilização inadequada do espaço cedido evitando assim danos ao patrimônio do objeto do presente termo de permissão.`,
        `PARÁGRAFO ÚNICO - Os espaços físicos disponíveis são as áreas do auditório do Centro de Inovação do Jaraguá destinada à realização de eventos, compreendido o espaço de ${payload.area_m2_fmt} (banheiro masculino e feminino, 02 salas de tradução, 09 espaços destinados a cadeirantes, palco - com acesso externo -, 02 coxias, 02 camarins, 01 copa e 01 área técnica), do espaço aberto em frente ao auditório, não incluindo as baias e nem o coworking público, não sendo permitida apresentação musical fora do auditório, bem como não é permitido servir alimentos/bebidas dentro do auditório, de modo que qualquer violação destas será cobrada uma multa no valor de 10% do valor de locação.`
    ].forEach(p => textJustify(doc, p, { spaceAfter: 0.5 }));

    headingClausula(doc, 'CLÁUSULA QUINTA – DAS OBRIGAÇÕES DA PERMISSIONÁRIA');
    [
        `5.1 - Utilizar o espaço destinado no imóvel em questão para o fim específico do evento descrito na cláusula primeira.`,
        `5.2 - Conservar o imóvel como se lhe pertencesse, fazendo com que seu uso e gozo sejam pacíficos e harmônicos.`,
        `5.3 - A montagem e desmontagem de materiais e equipamentos do(a) PERMISSIONÁRIO(A) ou de terceiros, dentro do período de vigência, conforme reserva.`,
        `5.4 - A indenização pelos danos causados que, por si, seus empregados, prepostos e participantes do evento causarem ao mobiliário, equipamentos e acessórios das áreas locadas, independente de qualquer vistoria judicial prévia.`,
        `5.5 - A indenização por danos causados a terceiros no imóvel utilizado.`,
        `5.6 - A retirada do material e equipamentos utilizados dentro do período de vigência.`,
        `5.7 - Respeitar a lotação da área utilizada, sob pena do PERMITENTE providenciar a retirada do público excedente.`,
        `5.8 - Responsabilizar-se pelas despesas realizadas com a segurança, manutenção e conservação do bem permitido.`,
        `5.9 - Responsabilizar-se pela limpeza e manutenção da área locada durante a montagem, realização e desmontagem do evento, inclusive a compra dos materiais de limpeza.`,
        `5.10 - Responsabilizar-se pela locação de container e contratação de remoção de lixo durante a montagem, realização e desmontagem do evento.`,
        `5.11 - Restituir o espaço permitido em perfeito estado e condições, conforme Termo de Vistoria.`,
        `5.12 - O espaço locado deverá ser utilizado para o fim específico do evento descrito na cláusula primeira.`,
        `5.13 - Para a locação da referida área, o permissionário deverá, no momento da montagem do evento, participar de um check list de vistoria junto a servidor designado pela SECTI e, ao final do evento, na desmontagem, entregar o espaço nas mesmas condições encontradas, incluindo infraestrutura, mobília e limpeza do ambiente, sob pena de multa no valor de locação do espaço.`,
        `5.14 - O permissionário deverá apresentar o projeto do evento com o layout, incluindo os pontos de iluminação, para que seja atestada a necessidade de ser utilizado ou não gerador. Caso seja atestada a necessidade, o permissionário deverá arcar com o aluguel de um gerador externo para não sobrecarregar a rede elétrica do Centro de Inovação do Jaraguá, de modo a evitar danos à estrutura.`,
        `5.15 - Toda estrutura que não for retirada no dia da desmontagem que consta neste termo de permissão de uso será destinada a outros fins, bem como será aplicada multa no valor de 10% da locação.`,
        `5.16 - É vedada a utilização da porta de emergência para fins que não seja de segurança, tais como movimentação de estrutura de eventos, sob pena de multa em caso de desobediência.`,
        `5.17 - É proibido o consumo de comidas/bebidas dentro do auditório ou do anfiteatro, de modo que havendo violação deverá ser aplicada multa de 10% do valor de locação, bem como deverá arcar com o valor de danos, caso tenha ocorrido.`,
        `5.18 - É proibido som e/ou apresentação musical fora do auditório, sob pena de multa.`
    ].forEach(p => textJustify(doc, p, { spaceAfter: 0.5 }));


    headingClausula(doc, 'CLÁUSULA SEXTA – DAS PENALIDADES');
    [
        `6.1 - O descumprimento das cláusulas ora pactuadas por qualquer das partes acarretará a incidência de multa equivalente a 10% (dez por cento) do valor da permissão, a ser paga pela parte que deu causa em favor da parte inocente.`,
        `6.2 - O valor descrito no item anterior deverá ser corrigido com base no IPCA do período correspondente, montante sobre o qual incidirão juros moratórios de 1% (um por cento) ao mês, calculado pro rata die.`,
        `6.3 - Na hipótese de rescisão ocasionada pelo(a) PERMISSIONÁRIO(A) por desistência ou cancelamento do evento até os 30 (trinta) dias de antecedência o permissionário deverá ser penalizado com a perda da taxa de reserva mais multa de 20% (vinte por cento) sobre o valor do presente termo.`,
        `6.4 - Em caso de violação das normas previstas neste contrato e no regimento interno, e havendo inadimplemento da multa aplicada e/ou ausência de manifestação por parte do permissionário, este poderá ser impedido de realizar reservas dos espaços por até 2 (dois) anos, contados a partir da data da notificação.`
    ].forEach(p => textJustify(doc, p, { spaceAfter: 0.5 }));

    headingClausula(doc, 'CLÁUSULA SÉTIMA – DA RESCISÃO');
    [
        `7.1 - A inexecução total ou parcial deste termo poderá acarretar em sanções administrativas, conforme disposto nos artigos 104, 137, 138 e 139 da Lei nº 14.133/2021.`,
        `7.2 – O presente instrumento poderá ser rescindido a qualquer tempo pelo(a) PERMISSIONÁRIO(A), com notificação prévia de, no mínimo, 30 (trinta) dias (para eventos particulares) e 90 (noventa) dias (para eventos públicos) antes da data originalmente agendada para o evento, devidamente protocolada na Secretaria Estadual da Ciência, da Tecnologia e da Inovação de Alagoas – SECTI.`,
        `7.2.1 – O não cumprimento do prazo mínimo de notificação impede a realização da alteração de data, sendo considerada desistência definitiva, sujeita às penalidades previstas neste instrumento.`,
        `7.2.2 – Nessa hipótese, o(a) PERMISSIONÁRIO(A) terá o direito de realizar o evento em nova data, desde que dentro do prazo máximo de 01 (um) ano a contar da data da assinatura do primeiro termo de permissão de uso, ficando desde já estabelecido que a alteração poderá ocorrer uma única vez, estando a nova data condicionada à disponibilidade de pauta. Caso não haja disponibilidade dentro desse período ou se o evento não for realizado na nova data agendada, o(a) PERMISSIONÁRIO(A) perderá integralmente os valores já pagos.`,
        `7.3 - Ocorrerá a rescisão do presente termo de permissão, independente de qualquer comunicação prévia ou indenização por parte da PERMITENTE, havendo qualquer sinistro, incêndio ou algo que venha impossibilitar a posse do espaço, independente de dolo ou culpa do PERMITENTE.`,
        `7.4 - Os casos de rescisão devem ser formalmente motivados nos autos do processo, assegurado o contraditório e a ampla defesa.`
    ].forEach(p => textJustify(doc, p, { spaceAfter: 0.5 }));

    headingClausula(doc, 'CLÁUSULA OITAVA – OMISSÕES CONTRATUAIS');
    textJustify(doc, `8.1 - Os casos omissos serão decididos pela PERMITENTE segundo as disposições contidas na Lei nº 14.133/2021, e nas demais normas de licitações e contratos administrativos, além de, subsidiariamente, as disposições contidas na Lei nº 8.078/90 – Código de Defesa do Consumidor, e normas e princípios gerais dos contratos.`);

    headingClausula(doc, 'CLÁUSULA NONA – DO FORO');
    textJustify(doc, `9.1 As questões decorrentes da execução deste Instrumento que não possam ser dirimidas administrativamente serão processadas e julgadas no Foro da Cidade de Maceió – AL, que prevalecerá sobre qualquer outro, por mais privilegiado que seja, para dirimir quaisquer dúvidas oriundas do presente Termo.`);

    // Texto de Fechamento
    doc.moveDown(2);
    textJustify(doc, `Para firmeza e validade do que foi pactuado, lavra-se o presente instrumento em 3 (três) vias de igual teor e forma, para que surtam um só efeito, as quais, depois de lidas, são assinadas pelos representantes das partes, PERMITENTE e PERMISSIONÁRIO(A) e pelas testemunhas abaixo.`);
    doc.moveDown(1);
    doc.text(`${payload.cidade_uf}, ${payload.data_assinatura}.`);
    doc.moveDown(4);

    // Linhas de assinatura
    const signLine = (label) => {
        doc.text('___________________________________________', { align: 'center' });
        doc.font('Times-Bold').text(label, { align: 'center' });
        doc.font('Times-Roman');
        doc.moveDown(3);
    };
    signLine('PERMITENTE');
    signLine('PERMISSIONÁRIA');
    signLine('TESTEMUNHA – CPF Nº');
    signLine('TESTEMUNHA – CPF Nº');


    // Adiciona o número da página no rodapé
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font('Times-Roman').fontSize(9).text(`Página ${i + 1} de ${range.count}`,
            doc.page.margins.left,
            doc.page.height - doc.page.margins.bottom + 10,
            { align: 'right' }
        );
    }

    // fim
    doc.end();
    await endPromise;
    const buffer = Buffer.concat(chunks);

    // grava + indexa
    const saved = await salvarRegistro(buffer, 'termo_evento', eventoId, evRow);

    return returnBuffer ? { ...saved, buffer } : saved;
}

module.exports = { gerarTermoEventoPdfEIndexar };
