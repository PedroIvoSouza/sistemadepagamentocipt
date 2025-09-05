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
    eventoGratuito = false,
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
  let eventoGratuitoFlag = eventoGratuito || clienteIsento;
  let justificativa = justificativaGratuito;
  if (clienteIsento && !justificativa) justificativa = 'Isento';

  if (!eventoGratuitoFlag && (!Array.isArray(parcelas) || parcelas.length === 0)) {
    throw new Error('Campos obrigatórios estão faltando.');
  }

  if (!eventoGratuitoFlag) {
    const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
      throw new Error(`A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`);
    }
  }
  const datasOrdenadas = Array.isArray(datasEvento) ? [...datasEvento].sort((a,b)=> new Date(a)-new Date(b)) : [];
  const dataVigenciaFinal = datasOrdenadas.length ? new Date(datasOrdenadas.at(-1)) : null;
  if (dataVigenciaFinal) {
    dataVigenciaFinal.setDate(dataVigenciaFinal.getDate() + 1);
  }

  await dbRun(db, 'BEGIN TRANSACTION');
  try {
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
        dataVigenciaFinal ? dataVigenciaFinal.toISOString().slice(0,10) : null,
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

    const cols = await dbAll(db, 'PRAGMA table_info(dars)');
    const hasDataEmissao = cols.some(c => c.name === 'data_emissao');

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
    throw err;
  }
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
    eventoGratuito = false,
    justificativaGratuito,
    emprestimoTvs = false,
    emprestimoCaixasSom = false,
    emprestimoMicrofones = false,
  } = data || {};
  if (!idCliente || !nomeEvento) {
    throw new Error('Campos obrigatórios estão faltando.');
  }

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
  let eventoGratuitoFlag = eventoGratuito || clienteIsento;
  let justificativa = justificativaGratuito;
  if (clienteIsento && !justificativa) justificativa = 'Isento';

  if (!eventoGratuitoFlag && (!Array.isArray(parcelas) || parcelas.length === 0)) {
    throw new Error('Campos obrigatórios estão faltando.');
  }
  if (!eventoGratuitoFlag) {
    const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
      throw new Error(`A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`);
    }
  }
  const datasOrdenadas = Array.isArray(datasEvento) ? [...datasEvento].sort((a,b)=> new Date(a)-new Date(b)) : [];
  const dataVigenciaFinal = datasOrdenadas.length ? new Date(datasOrdenadas.at(-1)) : null;
  if (dataVigenciaFinal) {
    dataVigenciaFinal.setDate(dataVigenciaFinal.getDate() + 1);
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
        dataVigenciaFinal ? dataVigenciaFinal.toISOString().slice(0,10) : null,
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

    const cols = await dbAll(db, 'PRAGMA table_info(dars)');
    const hasDataEmissao = cols.some(c => c.name === 'data_emissao');
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
    return id;
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
    `SELECT nome_razao_social, documento, endereco, cep FROM Clientes WHERE id = ?`,
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
    const darStmt = await dbRun(
      db,
      `INSERT INTO dars (valor, data_vencimento, status, mes_referencia, ano_referencia, permissionario_id, tipo_permissionario, data_emissao)
       VALUES (?, ?, 'Pendente', ?, ?, NULL, 'Advertencia', ?)`,
      [Number(valorMulta), vencimentoISO, Number(mes), Number(ano), hoje.toISOString()]
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
  emitirDarAdvertencia,
};

