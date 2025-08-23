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
  } = data;

  if (!idCliente || !nomeEvento || (!eventoGratuito && (!Array.isArray(parcelas) || parcelas.length === 0))) {
    throw new Error('Campos obrigatórios estão faltando.');
  }

  if (!eventoGratuito) {
    const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
      throw new Error(`A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`);
    }
  }
  const datasOrdenadas = Array.isArray(datasEvento) ? [...datasEvento].sort((a,b)=> new Date(a)-new Date(b)) : [];
  const dataVigenciaFinal = datasOrdenadas.length ? datasOrdenadas[datasOrdenadas.length-1] : null;

  await dbRun(db, 'BEGIN TRANSACTION');
  try {
    const eventoStmt = await dbRun(
      db,
      `INSERT INTO Eventos (
         id_cliente, nome_evento, espaco_utilizado, area_m2, datas_evento,
         data_vigencia_final, total_diarias, valor_bruto,
         tipo_desconto, desconto_manual, valor_final, numero_oficio_sei,
         hora_inicio, hora_fim, hora_montagem, hora_desmontagem,
         numero_processo, numero_termo, evento_gratuito, justificativa_gratuito, status
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )`,
      [
        idCliente,
        nomeEvento,
        JSON.stringify(espacosUtilizados || []),
        areaM2 != null ? Number(areaM2) : null,
        JSON.stringify(datasEvento || []),
        dataVigenciaFinal,
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
        eventoGratuito ? 1 : 0,
        justificativaGratuito || null,
        'Pendente'
      ]
    );

    const eventoId = eventoStmt.lastID;

    const cliente = await dbGet(
      db,
      `SELECT nome_razao_social, documento, endereco, cep
         FROM Clientes_Eventos WHERE id = ?`,
      [idCliente]
    );
    if (!cliente) throw new Error(`Cliente com ID ${idCliente} não foi encontrado no banco.`);

    if (!eventoGratuito) {
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
        const darStmt = await dbRun(
          db,
          `INSERT INTO dars (valor, data_vencimento, status, mes_referencia, ano_referencia, permissionario_id, tipo_permissionario)
           VALUES (?, ?, 'Pendente', ?, ?, NULL, 'Evento')`,
          [valorParcela, vencimentoISO, Number(mes), Number(ano)]
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
        const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
        const pdf = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDoc);
        await dbRun(
          db,
          `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
          [retorno.numeroGuia, pdf, darId]
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
  } = data || {};
  if (!idCliente || !nomeEvento || (!eventoGratuito && (!Array.isArray(parcelas) || parcelas.length === 0))) {
    throw new Error('Campos obrigatórios estão faltando.');
  }
  if (!eventoGratuito) {
    const somaParcelas = parcelas.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    if (Math.abs(somaParcelas - Number(valorFinal || 0)) > 0.01) {
      throw new Error(`A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) não corresponde ao Valor Final (R$ ${Number(valorFinal||0).toFixed(2)}).`);
    }
  }
  const datasOrdenadas = Array.isArray(datasEvento) ? [...datasEvento].sort((a,b)=> new Date(a)-new Date(b)) : [];
  const dataVigenciaFinal = datasOrdenadas.length ? datasOrdenadas[datasOrdenadas.length-1] : null;

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
        dataVigenciaFinal,
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
        eventoGratuito ? 1 : 0,
        justificativaGratuito || null,
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

    const cliente = await dbGet(
      db,
      `SELECT nome_razao_social, documento, endereco, cep
         FROM Clientes_Eventos
        WHERE id = ?`,
      [idCliente]
    );
    if (!cliente) {
      throw new Error(`Cliente com ID ${idCliente} não encontrado.`);
    }

    if (!eventoGratuito) {
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
        const darStmt = await dbRun(
          db,
          `INSERT INTO dars (valor, data_vencimento, status, mes_referencia, ano_referencia, permissionario_id, tipo_permissionario)
           VALUES (?, ?, 'Pendente', ?, ?, NULL, 'Evento')`,
          [valorParcela, vencimentoISO, Number(mes), Number(ano)]
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
        const tokenDoc = await gerarTokenDocumento('DAR_EVENTO', null, db);
        const pdf = await imprimirTokenEmPdf(retorno.pdfBase64, tokenDoc);
        await dbRun(
          db,
          `UPDATE dars SET numero_documento = ?, pdf_url = ?, status = 'Emitido' WHERE id = ?`,
          [retorno.numeroGuia, pdf, darId]
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

module.exports = {
  criarEventoComDars,
  atualizarEventoComDars,
};

