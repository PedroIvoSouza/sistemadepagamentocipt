const { gerarTermoEventoPdfkitEIndexar } = require('./termoEventoPdfkitService');

const onlyDigits = (v = '') => String(v).replace(/\D/g, '');

const dbRun = (db, sql, p = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, p, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const dbGet = (db, sql, p = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, p, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const dbAll = (db, sql, p = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, p, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

async function getNextNumeroTermo(db, year = new Date().getFullYear()) {
  const row = await dbGet(
    db,
    `SELECT numero_termo FROM Eventos WHERE numero_termo LIKE ? ORDER BY CAST(SUBSTR(numero_termo,1,INSTR(numero_termo,'/')-1) AS INTEGER) DESC LIMIT 1`,
    [`%/${year}`]
  );
  const current = row?.numero_termo ? Number(row.numero_termo.split('/')[0]) : 0;
  const next = String(current + 1).padStart(3, '0');
  return `${next}/${year}`;
}

async function describeDarTable(db) {
  const columns = await dbAll(db, 'PRAGMA table_info(dars)');
  const names = new Set(columns.map(c => c.name));
  return {
    columns,
    hasDataEmissao: names.has('data_emissao'),
    hasManual: names.has('manual'),
    hasNumeroDocumento: names.has('numero_documento'),
    hasLinhaDigitavel: names.has('linha_digitavel'),
    hasCodigoBarras: names.has('codigo_barras'),
    hasPdfUrl: names.has('pdf_url'),
  };
}

const feriadosFixos = [
  '01/01', '21/04', '01/05', '24/06', '07/09',
  '16/09', '12/10', '02/11', '15/11', '25/12'
];

function isFeriado(date) {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  return feriadosFixos.includes(`${dia}/${mes}`);
}

function isDiaUtil(date) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !isFeriado(date);
}

function addDiasUteis(data, dias) {
  const d = new Date(data);
  let added = 0;
  while (added < dias) {
    d.setDate(d.getDate() + 1);
    if (isDiaUtil(d)) added++;
  }
  return d;
}

async function criarEventoComDars(db, data, helpers) {
  const {
    emitirGuiaSefaz,
    gerarTokenDocumento,
    imprimirTokenEmPdf,
  } = helpers;

  const {
    idCliente,
    nomeEvento,
    numeroOficioSei,
    datasEvento,
    totalDiarias,
    valorBruto,
    tipoDescontoAuto,
    descontoManualPercent,
    valorFinal,
    parcelas = [],
    espacosUtilizados = [],
    areaM2,
    horaInicio,
    horaFim,
    horaMontagem,
    horaDesmontagem,
    numeroProcesso,
    numeroTermo,
    eventoGratuito,
    justificativaGratuito,
    emprestimoTvs = false,
    emprestimoCaixasSom = false,
    emprestimoMicrofones = false,
  } = data;

  if (!idCliente || !nomeEvento) {
    throw new Error('Campos obrigatórios estão faltando.');
  }

  const cliente = await dbGet(
    db,
    `SELECT nome_razao_social, documento, endereco, cep, tipo_cliente, valor_aluguel FROM Clientes_Eventos WHERE id = ?`,
    [idCliente]
  );
  if (!cliente) throw new Error(`Cliente com ID ${idCliente} não foi encontrado no banco.`);

  const clienteIsento =
    cliente.tipo_cliente === 'Isento' || Number(cliente.valor_aluguel) === 0;
  let eventoGratuitoFlag =
    eventoGratuito !== undefined ? eventoGratuito : clienteIsento;
  let justificativa = justificativaGratuito;
  if (clienteIsento && eventoGratuitoFlag && !justificativa)
    justificativa = 'Isento';

  if (!eventoGratuitoFlag && (!Array.isArray(parcelas) || parcelas.length === 0)) {
    throw new Error('Campos obrigatórios estão faltando.');
  }

  if (!eventoGratuitoFlag) {
    const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
      throw new Error(`A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`);
    }
  }

  const datasOrdenadas = Array.isArray(datasEvento)
    ? [...datasEvento].sort((a, b) => new Date(a) - new Date(b))
    : [];
  let dataVigenciaFinal = data.dataVigenciaFinal || data.data_vigencia_final || null;
  if (!dataVigenciaFinal && datasOrdenadas.length) {
    const tmp = new Date(datasOrdenadas.at(-1));
    tmp.setDate(tmp.getDate() + 1);
    dataVigenciaFinal = tmp.toISOString().slice(0, 10);
  } else if (dataVigenciaFinal) {
    dataVigenciaFinal = new Date(dataVigenciaFinal).toISOString().slice(0, 10);
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let numeroTermoFinal = numeroTermo;
    try {
      await dbRun(db, 'BEGIN IMMEDIATE');
    } catch (err) {
      if (err?.code === 'SQLITE_BUSY') {
        continue;
      }
      throw err;
    }
    try {
      if (!numeroTermoFinal) {
        numeroTermoFinal = await getNextNumeroTermo(db, new Date().getFullYear());
      } else {
        const exists = await dbGet(db, 'SELECT 1 FROM Eventos WHERE numero_termo = ?', [numeroTermoFinal]);
        if (exists) throw new Error('Número de termo já existe.');
      }

      const datasEventoStr = JSON.stringify(datasEvento || []);
      const colsEvento = [
      'id_cliente', 'nome_evento', 'espaco_utilizado', 'area_m2', 'datas_evento',
      'datas_evento_original', 'data_vigencia_final', 'total_diarias', 'valor_bruto',
      'tipo_desconto', 'desconto_manual', 'valor_final', 'numero_oficio_sei',
      'hora_inicio', 'hora_fim', 'hora_montagem', 'hora_desmontagem',
      'numero_processo', 'numero_termo', 'remarcacao_solicitada', 'datas_evento_solicitada', 'data_aprovacao_remarcacao',
      'evento_gratuito', 'justificativa_gratuito', 'status',
      'emprestimo_tvs', 'emprestimo_caixas_som', 'emprestimo_microfones'
    ];
    const eventoStmt = await dbRun(
      db,
      `INSERT INTO Eventos (${colsEvento.join(', ')}) VALUES (${colsEvento.map(() => '?').join(', ')})`,
      [
        idCliente,
        nomeEvento,
        JSON.stringify(espacosUtilizados || []),
        areaM2 != null ? Number(areaM2) : null,
        datasEventoStr,
        datasEventoStr,
        dataVigenciaFinal || null,
        Number(totalDiarias || 0),
        Number(valorBruto || 0),
        String(tipoDescontoAuto || 'Geral'),
        Number(descontoManualPercent || 0),
        Number(valorFinal || 0),
        numeroOficioSei || null,
        horaInicio || null,
        horaFim || null,
        horaMontagem || null,
        horaDesmontagem || null,
        numeroProcesso || null,
        numeroTermoFinal || null,
        0,
        null,
        null,
        eventoGratuitoFlag ? 1 : 0,
        justificativa || null,
        'Pendente',
        emprestimoTvs ? 1 : 0,
        emprestimoCaixasSom ? 1 : 0,
        emprestimoMicrofones ? 1 : 0
      ]
    );

    const eventoId = eventoStmt.lastID;

    const darSchema = await describeDarTable(db);
    const { hasDataEmissao, hasManual } = darSchema;

    if (!eventoGratuitoFlag) {
      const documentoLimpo = onlyDigits(cliente.documento);
      const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
      const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
      if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');

      for (const [i, p] of parcelas.entries()) {
        const valorParcela = Number(p.valor) || 0;
        const vencimentoISO = p.vencimento;
        if (!vencimentoISO || Number.isNaN(new Date(`${vencimentoISO}T12:00:00`).getTime())) {
          throw new Error(`A data de vencimento da parcela ${i + 1} é inválida.`);
        }
        if (valorParcela <= 0) {
          throw new Error(`O valor da parcela ${i + 1} deve ser maior que zero.`);
        }
        const [ano, mes] = vencimentoISO.split('-');
        const darCols = ['valor', 'data_vencimento', 'status', 'mes_referencia', 'ano_referencia', 'permissionario_id', 'tipo_permissionario'];
        const darVals = [valorParcela, vencimentoISO, 'Pendente', Number(mes), Number(ano), null, 'Evento'];
        if (hasDataEmissao && p.data_emissao) {
          darCols.push('data_emissao');
          darVals.push(p.data_emissao);
        }
        if (hasManual) {
          darCols.push('manual');
          darVals.push(0);
        }
        const darStmt = await dbRun(
          db,
          `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(() => '?').join(',')})`,
          darVals
        );
        const darId = darStmt.lastID;

        await dbRun(
          db,
          `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
           VALUES (?, ?, ?, ?, ?)`,
          [darId, eventoId, i + 1, valorParcela, vencimentoISO]
        );

        const payloadSefaz = {
          versao: '1.0',
          contribuinteEmitente: {
            codigoTipoInscricao: tipoInscricao,
            numeroInscricao: documentoLimpo,
            nome: cliente.nome_razao_social,
            codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
            descricaoEndereco: cliente.endereco,
            numeroCep: onlyDigits(cliente.cep)
          },
          receitas: [{
            codigo: receitaCod,
            competencia: { mes: Number(mes), ano: Number(ano) },
            valorPrincipal: valorParcela,
            valorDesconto: 0.00,
            dataVencimento: vencimentoISO
          }],
          dataLimitePagamento: vencimentoISO,
          observacao: `CIPT Evento: ${nomeEvento} (Montagem ${horaMontagem || '-'}; Evento ${horaInicio || '-'}-${horaFim || '-'}; Desmontagem ${horaDesmontagem || '-'}) | Parcela ${i + 1} de ${parcelas.length}`
        };

        const retorno = await emitirGuiaSefaz(payloadSefaz);
        const { linhaDigitavel, codigoBarras } = retorno;
        const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
        const pdf = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDoc);
        const extraCols = [];
        const extraVals = [];
        if (linhaDigitavel) {
          extraCols.push('linha_digitavel = ?');
          extraVals.push(linhaDigitavel);
        }
        if (codigoBarras) {
          extraCols.push('codigo_barras = ?');
          extraVals.push(codigoBarras);
        }
        await dbRun(
          db,
          `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido'${extraCols.length ? ', ' + extraCols.join(', ') : ''} WHERE id = ?`,
          [retorno.numeroGuia, pdf, ...extraVals, darId]
        );
      }
    }

    await dbRun(db, 'COMMIT');
    return eventoId;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch {}
    if (!numeroTermo && err?.code === 'SQLITE_CONSTRAINT') {
      continue;
    }
    throw err;
  }
  }
  throw new Error('Não foi possível gerar número de termo único.');
}

async function atualizarEventoComDars(db, id, data, helpers) {
  const {
    emitirGuiaSefaz,
    gerarTokenDocumento,
    imprimirTokenEmPdf,
  } = helpers;

  const {
    idCliente,
    nomeEvento,
    numeroOficioSei,
    espacosUtilizados = [],
    areaM2 = null,
    datasEvento = [],
    totalDiarias = 0,
    valorBruto = 0,
    tipoDescontoAuto = null,
    descontoManualPercent = 0,
    valorFinal = 0,
    parcelas = [],
    horaInicio,
    horaFim,
    horaMontagem,
    horaDesmontagem,
    numeroProcesso,
    numeroTermo,
    eventoGratuito,
    justificativaGratuito,
    emprestimoTvs = false,
    emprestimoCaixasSom = false,
    emprestimoMicrofones = false,
  } = data || {};
  if (!idCliente || !nomeEvento) {
    throw new Error('Campos obrigatórios estão faltando.');
  }

  const originalEvento = await dbGet(
    db,
    `SELECT nome_evento, espaco_utilizado, area_m2, datas_evento, data_vigencia_final,
            total_diarias, valor_bruto, tipo_desconto, desconto_manual, valor_final,
            numero_oficio_sei, hora_inicio, hora_fim, hora_montagem, hora_desmontagem,
            numero_processo, numero_termo, emprestimo_tvs, emprestimo_caixas_som,
            emprestimo_microfones, evento_gratuito, justificativa_gratuito
       FROM Eventos WHERE id = ?`,
    [id]
  );
  if (!originalEvento) {
    throw Object.assign(new Error('Evento não encontrado.'), { status: 404 });
  }

  const normalizeArrayCampo = (valor) => {
    if (!valor) return [];
    if (Array.isArray(valor)) return valor.map((v) => String(v)).filter(Boolean);
    if (typeof valor === 'string') {
      const trimmed = valor.trim();
      if (!trimmed) return [];
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return arr.map((v) => String(v)).filter(Boolean);
      } catch {}
      return trimmed
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return [];
  };

  const cmpArrays = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };

  let termoPrecisaNovaVersao = false;

  const cliente = await dbGet(
    db,
    `SELECT nome_razao_social, documento, endereco, cep, tipo_cliente, valor_aluguel FROM Clientes_Eventos WHERE id = ?`,
    [idCliente]
  );
  if (!cliente) {
    throw new Error(`Cliente com ID ${idCliente} não encontrado.`);
  }

  const clienteIsento =
    cliente.tipo_cliente === 'Isento' || Number(cliente.valor_aluguel) === 0;
  let eventoGratuitoFlag =
    eventoGratuito !== undefined ? eventoGratuito : clienteIsento;
  let justificativa = justificativaGratuito;
  if (clienteIsento && eventoGratuitoFlag && !justificativa)
    justificativa = 'Isento';

  if (!eventoGratuitoFlag && (!Array.isArray(parcelas) || parcelas.length === 0)) {
    throw new Error('Campos obrigatórios estão faltando.');
  }
  if (!eventoGratuitoFlag) {
    const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
      throw new Error(`A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`);
    }
  }
  const datasOrdenadas = Array.isArray(datasEvento)
    ? [...datasEvento].sort((a, b) => new Date(a) - new Date(b))
    : [];
  let dataVigenciaFinal = data.dataVigenciaFinal || data.data_vigencia_final || null;
  if (!dataVigenciaFinal && datasOrdenadas.length) {
    const tmp = new Date(datasOrdenadas.at(-1));
    tmp.setDate(tmp.getDate() + 1);
    dataVigenciaFinal = tmp.toISOString().slice(0, 10);
  } else if (dataVigenciaFinal) {
    dataVigenciaFinal = new Date(dataVigenciaFinal).toISOString().slice(0, 10);
  }

  const normalizaTexto = (v) => (v == null ? '' : String(v).trim());
  const normalizaNumero = (v) => Number(v == null ? 0 : v);
  const normalizaHora = (v) => (v == null ? '' : String(v).trim());

  const origDatas = normalizeArrayCampo(originalEvento.datas_evento).map((d) => d);
  const novasDatas = normalizeArrayCampo(datasEvento).map((d) => d);
  const datasOrigOrdenadas = [...origDatas].sort();
  const datasNovasOrdenadas = [...novasDatas].sort();
  if (!cmpArrays(datasOrigOrdenadas, datasNovasOrdenadas)) {
    termoPrecisaNovaVersao = true;
  }

  const espacosOrig = normalizeArrayCampo(originalEvento.espaco_utilizado).map((d) => d.toLowerCase());
  const espacosNovos = normalizeArrayCampo(espacosUtilizados).map((d) => d.toLowerCase());
  const espacosOrigOrdenados = [...espacosOrig].sort();
  const espacosNovosOrdenados = [...espacosNovos].sort();
  if (!cmpArrays(espacosOrigOrdenados, espacosNovosOrdenados)) {
    termoPrecisaNovaVersao = true;
  }

  const comparacoesSimples = [
    [normalizaTexto(originalEvento.nome_evento), normalizaTexto(nomeEvento)],
    [normalizaTexto(originalEvento.numero_processo), normalizaTexto(numeroProcesso)],
    [normalizaTexto(originalEvento.numero_termo), normalizaTexto(numeroTermo)],
    [normalizaTexto(originalEvento.hora_inicio), normalizaHora(horaInicio)],
    [normalizaTexto(originalEvento.hora_fim), normalizaHora(horaFim)],
    [normalizaTexto(originalEvento.hora_montagem), normalizaHora(horaMontagem)],
    [normalizaTexto(originalEvento.hora_desmontagem), normalizaHora(horaDesmontagem)],
    [normalizaTexto(originalEvento.numero_oficio_sei), normalizaTexto(numeroOficioSei)],
    [normalizaTexto(originalEvento.justificativa_gratuito), normalizaTexto(justificativaGratuito)],
  ];

  for (const [anterior, atual] of comparacoesSimples) {
    if (anterior !== atual) {
      termoPrecisaNovaVersao = true;
      break;
    }
  }

  if (!termoPrecisaNovaVersao) {
    const comparacoesNumericas = [
      [normalizaNumero(originalEvento.area_m2), normalizaNumero(areaM2)],
      [normalizaNumero(originalEvento.total_diarias), normalizaNumero(totalDiarias)],
      [normalizaNumero(originalEvento.valor_bruto), normalizaNumero(valorBruto)],
      [normalizaNumero(originalEvento.desconto_manual), normalizaNumero(descontoManualPercent)],
      [normalizaNumero(originalEvento.valor_final), normalizaNumero(valorFinal)],
    ];
    for (const [anterior, atual] of comparacoesNumericas) {
      if (Number(anterior || 0).toFixed(2) !== Number(atual || 0).toFixed(2)) {
        termoPrecisaNovaVersao = true;
        break;
      }
    }
  }

  if (!termoPrecisaNovaVersao) {
    const tipoDescontoAnterior = normalizaTexto(originalEvento.tipo_desconto);
    const tipoDescontoAtual = normalizaTexto(tipoDescontoAuto || originalEvento.tipo_desconto);
    if (tipoDescontoAnterior !== tipoDescontoAtual) {
      termoPrecisaNovaVersao = true;
    }
  }

  const eventoGratuitoAnterior = Number(originalEvento.evento_gratuito) ? 1 : 0;
  const eventoGratuitoAtual = eventoGratuitoFlag ? 1 : 0;
  if (eventoGratuitoAnterior !== eventoGratuitoAtual) {
    termoPrecisaNovaVersao = true;
  }

  await dbRun(db, 'BEGIN TRANSACTION');
  try {
    const upd = await dbRun(
      db,
      `UPDATE Eventos
          SET id_cliente = ?,
              nome_evento = ?,
              espaco_utilizado = ?,
              area_m2 = ?,
              datas_evento = ?,
              data_vigencia_final = ?,
              total_diarias = ?,
              valor_bruto = ?,
              tipo_desconto = ?,
              desconto_manual = ?,
              valor_final = ?,
              numero_oficio_sei = ?,
              hora_inicio = ?,
              hora_fim = ?,
              hora_montagem = ?,
              hora_desmontagem = ?,
              numero_processo = ?,
              numero_termo = ?,
              emprestimo_tvs = ?,
              emprestimo_caixas_som = ?,
              emprestimo_microfones = ?,
              evento_gratuito = ?,
              justificativa_gratuito = ?,
              status = ?
        WHERE id = ?`,
      [
        idCliente,
        nomeEvento,
        JSON.stringify(espacosUtilizados || []),
        areaM2 != null ? Number(areaM2) : null,
        JSON.stringify(datasEvento || []),
        dataVigenciaFinal || null,
        Number(totalDiarias || 0),
        Number(valorBruto || 0),
        String(tipoDescontoAuto || 'Geral'),
        Number(descontoManualPercent || 0),
        Number(valorFinal || 0),
        numeroOficioSei || null,
        horaInicio || null,
        horaFim || null,
        horaMontagem || null,
        horaDesmontagem || null,
        numeroProcesso || null,
        numeroTermo || null,
        emprestimoTvs ? 1 : 0,
        emprestimoCaixasSom ? 1 : 0,
        emprestimoMicrofones ? 1 : 0,
        eventoGratuitoFlag ? 1 : 0,
        justificativa || null,
        'Pendente',
        id
      ]
    );

    if (upd.changes === 0) {
      throw Object.assign(new Error('Evento não encontrado.'), { status: 404 });
    }

    const antigos = await dbAll(
      db,
      'SELECT id_dar FROM DARs_Eventos WHERE id_evento = ?',
      [id]
    );
    const antigosIds = antigos.map(r => r.id_dar);
    await dbRun(db, 'DELETE FROM DARs_Eventos WHERE id_evento = ?', [id]);
    if (antigosIds.length) {
      const ph = antigosIds.map(() => '?').join(',');
      await dbRun(db, `DELETE FROM dars WHERE id IN (${ph})`, antigosIds);
    }

    const darSchema = await describeDarTable(db);
    const { hasDataEmissao, hasManual } = darSchema;
    if (!eventoGratuitoFlag) {
      const docLimpo = onlyDigits(cliente.documento);
      const tipoInscricao = docLimpo.length === 11 ? 3 : 4;
      const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
      if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');

      for (let i = 0; i < parcelas.length; i++) {
        const p = parcelas[i];
        const valorParcela = Number(p.valor) || 0;
        const vencimentoISO = p.vencimento;
        if (!vencimentoISO || !(new Date(vencimentoISO).getTime() > 0)) {
          throw new Error(`A data de vencimento da parcela ${i + 1} é inválida.`);
        }
        if (valorParcela <= 0) {
          throw new Error(`O valor da parcela ${i + 1} deve ser maior que zero.`);
        }
        const [ano, mes] = vencimentoISO.split('-');
        const darCols = ['valor', 'data_vencimento', 'status', 'mes_referencia', 'ano_referencia', 'permissionario_id', 'tipo_permissionario'];
        const darVals = [valorParcela, vencimentoISO, 'Pendente', Number(mes), Number(ano), null, 'Evento'];
        if (hasDataEmissao && p.data_emissao) {
          darCols.push('data_emissao');
          darVals.push(p.data_emissao);
        }
        if (hasManual) {
          darCols.push('manual');
          darVals.push(0);
        }
        const darStmt = await dbRun(
          db,
          `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(() => '?').join(',')})`,
          darVals
        );
        const darId = darStmt.lastID;
        await dbRun(
          db,
          `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
           VALUES (?, ?, ?, ?, ?)`,
          [darId, id, i + 1, valorParcela, vencimentoISO]
        );

        const payloadSefaz = {
          versao: '1.0',
          contribuinteEmitente: {
            codigoTipoInscricao: tipoInscricao,
            numeroInscricao: docLimpo,
            nome: cliente.nome_razao_social,
            codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
            descricaoEndereco: cliente.endereco,
            numeroCep: onlyDigits(cliente.cep)
          },
          receitas: [{
            codigo: receitaCod,
            competencia: { mes: Number(mes), ano: Number(ano) },
            valorPrincipal: valorParcela,
            valorDesconto: 0.00,
            dataVencimento: vencimentoISO
          }],
          dataLimitePagamento: vencimentoISO,
          observacao: `CIPT Evento: ${nomeEvento} (Montagem ${horaMontagem || '-'}; Evento ${horaInicio || '-'}-${horaFim || '-'}; Desmontagem ${horaDesmontagem || '-'}) | Parcela ${i + 1} de ${parcelas.length} (Atualização)`
        };

        const retorno = await emitirGuiaSefaz(payloadSefaz);
        const { linhaDigitavel, codigoBarras } = retorno;
        const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
        const pdf = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDoc);
        const extraCols = [];
        const extraVals = [];
        if (linhaDigitavel) {
          extraCols.push('linha_digitavel = ?');
          extraVals.push(linhaDigitavel);
        }
        if (codigoBarras) {
          extraCols.push('codigo_barras = ?');
          extraVals.push(codigoBarras);
        }
        await dbRun(
          db,
          `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido'${extraCols.length ? ', ' + extraCols.join(', ') : ''} WHERE id = ?`,
          [retorno.numeroGuia, pdf, ...extraVals, darId]
        );
      }
    }

    await dbRun(db, 'COMMIT');

    if (termoPrecisaNovaVersao) {
      await gerarTermoEventoPdfkitEIndexar(id, { novaVersao: true });
    }

    return id;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch {}
    throw err;
  }
}

async function criarDarManualEvento(db, eventoId, payload = {}, helpers = {}) {
  const {
    emitirGuiaSefaz = require('./sefazService').emitirGuiaSefaz,
    gerarTokenDocumento = require('../utils/token').gerarTokenDocumento,
    imprimirTokenEmPdf = require('../utils/token').imprimirTokenEmPdf,
  } = helpers;

  if (!db) throw new Error('Banco de dados não fornecido.');
  const id = Number(eventoId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Evento inválido.');
  }

  const evento = await dbGet(
    db,
    `SELECT e.id, e.nome_evento, c.nome_razao_social, c.documento, c.endereco, c.cep
       FROM Eventos e
       JOIN Clientes_Eventos c ON c.id = e.id_cliente
      WHERE e.id = ?`,
    [id]
  );
  if (!evento) {
    const err = new Error('Evento não encontrado.');
    err.status = 404;
    throw err;
  }

  const valorNumber = Number(payload.valor);
  if (!Number.isFinite(valorNumber) || valorNumber <= 0) {
    throw new Error('Valor da DAR manual inválido.');
  }

  const vencimentoStr = payload.vencimento || payload.data_vencimento;
  if (!vencimentoStr) {
    throw new Error('Data de vencimento é obrigatória.');
  }
  const vencDate = new Date(`${vencimentoStr}T00:00:00`);
  if (Number.isNaN(vencDate.getTime())) {
    throw new Error('Data de vencimento inválida.');
  }
  const vencimentoISO = vencDate.toISOString().slice(0, 10);
  const mesRef = Number(vencimentoISO.slice(5, 7));
  const anoRef = Number(vencimentoISO.slice(0, 4));

  let numeroParcela = Number(payload.numero_parcela || payload.parcela || payload.parcela_num);
  if (!Number.isInteger(numeroParcela) || numeroParcela <= 0) {
    const current = await dbGet(
      db,
      'SELECT MAX(numero_parcela) AS maxParcela FROM DARs_Eventos WHERE id_evento = ?',
      [id]
    );
    numeroParcela = Number(current?.maxParcela || 0) + 1;
  }

  const existingVinculo = await dbGet(
    db,
    `SELECT de.id            AS vinculo_id,
            de.id_dar       AS vinculo_dar_id,
            d.status        AS dar_status
       FROM DARs_Eventos de
  LEFT JOIN dars d ON d.id = de.id_dar
      WHERE de.id_evento = ? AND de.numero_parcela = ?`,
    [id, numeroParcela]
  );

  if (existingVinculo?.dar_status === 'Pago') {
    const err = new Error('Não é possível substituir uma DAR já paga.');
    err.status = 409;
    throw err;
  }

  const documentoLimpo = onlyDigits(evento.documento);
  if (!documentoLimpo) {
    throw new Error('Documento do cliente inválido.');
  }
  const tipoInscricao = documentoLimpo.length === 11 ? 3 : 4;
  const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
  if (!receitaCod) {
    throw new Error('RECEITA_CODIGO_EVENTO inválido.');
  }

  const totalParcelasRow = await dbGet(
    db,
    'SELECT COUNT(*) AS total FROM DARs_Eventos WHERE id_evento = ?',
    [id]
  );
  const totalParcelas = Math.max(Number(totalParcelasRow?.total || 0), numeroParcela);

  const payloadSefaz = {
    versao: '1.0',
    contribuinteEmitente: {
      codigoTipoInscricao: tipoInscricao,
      numeroInscricao: documentoLimpo,
      nome: evento.nome_razao_social,
      codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
      descricaoEndereco: evento.endereco || '-',
      numeroCep: onlyDigits(evento.cep),
    },
    receitas: [{
      codigo: receitaCod,
      competencia: { mes: mesRef, ano: anoRef },
      valorPrincipal: Number(valorNumber.toFixed(2)),
      valorDesconto: 0,
      dataVencimento: vencimentoISO,
    }],
    dataLimitePagamento: vencimentoISO,
    observacao: `CIPT Evento: ${evento.nome_evento || ''} | Parcela ${numeroParcela} de ${totalParcelas}`,
  };

  const darSchema = await describeDarTable(db);
  const nowISO = new Date().toISOString();

  await dbRun(db, 'BEGIN TRANSACTION');
  try {
    let darId = Number(existingVinculo?.vinculo_dar_id) || null;

    if (darId) {
      const baseCols = ['valor = ?', 'data_vencimento = ?', 'mes_referencia = ?', 'ano_referencia = ?', 'status = ?'];
      const baseVals = [valorNumber, vencimentoISO, mesRef, anoRef, 'Pendente'];
      if (darSchema.hasManual) {
        baseCols.push('manual = ?');
        baseVals.push(0);
      }
      if (darSchema.hasDataEmissao) {
        baseCols.push('data_emissao = ?');
        baseVals.push(nowISO);
      }
      await dbRun(db, `UPDATE dars SET ${baseCols.join(', ')} WHERE id = ?`, [...baseVals, darId]);
    } else {
      const darCols = ['valor', 'data_vencimento', 'status', 'mes_referencia', 'ano_referencia', 'permissionario_id', 'tipo_permissionario'];
      const darVals = [valorNumber, vencimentoISO, 'Pendente', mesRef, anoRef, null, 'Evento'];
      if (darSchema.hasDataEmissao) {
        darCols.push('data_emissao');
        darVals.push(nowISO);
      }
      if (darSchema.hasManual) {
        darCols.push('manual');
        darVals.push(0);
      }
      const darStmt = await dbRun(
        db,
        `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(() => '?').join(',')})`,
        darVals
      );
      darId = darStmt.lastID;
    }

    const retorno = await emitirGuiaSefaz(payloadSefaz);
    if (!retorno || !retorno.pdfBase64 || !retorno.numeroGuia) {
      throw new Error('Retorno inválido ao emitir a DAR na SEFAZ.');
    }

    const tokenDocumento = await gerarTokenDocumento('DAR_EVENTO', null, db);
    const pdfComToken = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDocumento, { onlyLastPage: true });

    const statusFinal =
      existingVinculo?.vinculo_dar_id && existingVinculo.dar_status && existingVinculo.dar_status !== 'Pendente'
        ? 'Reemitido'
        : 'Emitido';

    const updateCols = ['valor = ?', 'data_vencimento = ?', 'mes_referencia = ?', 'ano_referencia = ?', 'status = ?'];
    const updateVals = [valorNumber, vencimentoISO, mesRef, anoRef, statusFinal];

    if (darSchema.hasNumeroDocumento) {
      updateCols.push('numero_documento = ?');
      updateVals.push(retorno.numeroGuia);
    }
    if (darSchema.hasPdfUrl) {
      updateCols.push('pdf_url = ?');
      updateVals.push(pdfComToken);
    }
    if (darSchema.hasLinhaDigitavel) {
      updateCols.push('linha_digitavel = ?');
      updateVals.push(retorno.linhaDigitavel || null);
    }
    if (darSchema.hasCodigoBarras) {
      updateCols.push('codigo_barras = ?');
      updateVals.push(retorno.codigoBarras || null);
    }
    if (darSchema.hasManual) {
      updateCols.push('manual = ?');
      updateVals.push(0);
    }
    if (darSchema.hasDataEmissao) {
      updateCols.push('data_emissao = ?');
      updateVals.push(nowISO);
    }

    await dbRun(
      db,
      `UPDATE dars SET ${updateCols.join(', ')} WHERE id = ?`,
      [...updateVals, darId]
    );

    if (existingVinculo?.vinculo_id) {
      await dbRun(
        db,
        `UPDATE DARs_Eventos SET id_dar = ?, valor_parcela = ?, data_vencimento = ? WHERE id = ?`,
        [darId, valorNumber, vencimentoISO, existingVinculo.vinculo_id]
      );
    } else {
      const updateJoin = await dbRun(
        db,
        `UPDATE DARs_Eventos SET id_dar = ?, valor_parcela = ?, data_vencimento = ? WHERE id_evento = ? AND numero_parcela = ?`,
        [darId, valorNumber, vencimentoISO, id, numeroParcela]
      );
      if (!updateJoin || !updateJoin.changes) {
        await dbRun(
          db,
          `INSERT INTO DARs_Eventos (id_dar, id_evento, numero_parcela, valor_parcela, data_vencimento)
           VALUES (?, ?, ?, ?, ?)`,
          [darId, id, numeroParcela, valorNumber, vencimentoISO]
        );
      }
    }

    await dbRun(db, 'COMMIT');

    return {
      id: darId,
      numero_parcela: numeroParcela,
      valor: valorNumber,
      vencimento: vencimentoISO,
      status: statusFinal,
      manual: darSchema.hasManual ? 0 : undefined,
      numero_documento: darSchema.hasNumeroDocumento ? retorno.numeroGuia : undefined,
      linha_digitavel: darSchema.hasLinhaDigitavel ? retorno.linhaDigitavel || null : undefined,
      codigo_barras: darSchema.hasCodigoBarras ? retorno.codigoBarras || null : undefined,
      pdf_url: darSchema.hasPdfUrl ? pdfComToken : undefined,
    };
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch {}
    throw err;
  }
}

async function emitirDarAdvertencia(evento, valorMulta, { db, helpers = {}, hoje = new Date() } = {}) {
  const {
    emitirGuiaSefaz = require('./sefazService').emitirGuiaSefaz,
    gerarTokenDocumento = require('../utils/token').gerarTokenDocumento,
    imprimirTokenEmPdf = require('../utils/token').imprimirTokenEmPdf,
  } = helpers;

  if (!db) throw new Error('Banco de dados não fornecido');
  if (!evento || !evento.id || !evento.cliente_id) {
    throw new Error('Advertência inválida.');
  }

  const cliente = await dbGet(
    db,
    `SELECT nome_razao_social, documento, endereco, cep FROM Clientes_Eventos WHERE id = ?`,
    [evento.cliente_id]
  );
  if (!cliente) throw new Error('Cliente não encontrado.');

  const receitaCod = Number(String(process.env.RECEITA_CODIGO_EVENTO).replace(/\D/g, ''));
  if (!receitaCod) throw new Error('RECEITA_CODIGO_EVENTO inválido.');

  const vencimento = addDiasUteis(hoje, 5);
  const vencimentoISO = vencimento.toISOString().slice(0, 10);
  const [ano, mes] = vencimentoISO.split('-');

  await dbRun(db, 'BEGIN TRANSACTION');
  try {
    const darSchema = await describeDarTable(db);
    const darCols = ['valor', 'data_vencimento', 'status', 'mes_referencia', 'ano_referencia', 'permissionario_id', 'tipo_permissionario'];
    const darVals = [Number(valorMulta), vencimentoISO, 'Pendente', Number(mes), Number(ano), null, 'Advertencia'];
    if (darSchema.hasDataEmissao) {
      darCols.push('data_emissao');
      darVals.push(hoje.toISOString());
    }
    if (darSchema.hasManual) {
      darCols.push('manual');
      darVals.push(0);
    }
    const darStmt = await dbRun(
      db,
      `INSERT INTO dars (${darCols.join(',')}) VALUES (${darCols.map(() => '?').join(',')})`,
      darVals
    );
    const darId = darStmt.lastID;

    const payloadSefaz = {
      versao: '1.0',
      contribuinteEmitente: {
        codigoTipoInscricao: onlyDigits(cliente.documento).length === 11 ? 3 : 4,
        numeroInscricao: onlyDigits(cliente.documento),
        nome: cliente.nome_razao_social,
        codigoIbgeMunicipio: Number(process.env.COD_IBGE_MUNICIPIO),
        descricaoEndereco: cliente.endereco,
        numeroCep: onlyDigits(cliente.cep),
      },
      receitas: [{
        codigo: receitaCod,
        competencia: { mes: Number(mes), ano: Number(ano) },
        valorPrincipal: Number(valorMulta),
        valorDesconto: 0,
        dataVencimento: vencimentoISO,
      }],
      dataLimitePagamento: vencimentoISO,
      observacao: `CIPT Advertência: ${evento.nome_evento || ''}`,
    };

    const retorno = await emitirGuiaSefaz(payloadSefaz);
    const tokenDoc = await gerarTokenDocumento('DAR_ADVERTENCIA', null, db);
    const pdf = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDoc);

    const extraCols = [];
    const extraVals = [];
    if (retorno.linhaDigitavel) {
      extraCols.push('linha_digitavel = ?');
      extraVals.push(retorno.linhaDigitavel);
    }
    if (retorno.codigoBarras) {
      extraCols.push('codigo_barras = ?');
      extraVals.push(retorno.codigoBarras);
    }
    await dbRun(
      db,
      `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido'${extraCols.length ? ', ' + extraCols.join(', ') : ''} WHERE id = ?`,
      [retorno.numeroGuia, pdf, ...extraVals, darId]
    );

    await dbRun(db, `UPDATE Advertencias SET dar_id = ?, valor_multa = ? WHERE id = ?`, [darId, Number(valorMulta), evento.id]);

    await dbRun(db, 'COMMIT');
    return darId;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch {}
    throw err;
  }
}

module.exports = {
  criarEventoComDars,
  atualizarEventoComDars,
  criarDarManualEvento,
  emitirDarAdvertencia,
  getNextNumeroTermo,
};

