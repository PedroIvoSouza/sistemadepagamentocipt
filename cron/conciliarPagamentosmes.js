// ======= Conciliação =======
async function conciliarPagamentosD1() {
  console.log(`[CONCILIA] Iniciando conciliação do MÊS ATUAL... DB=${DB_PATH}`);

  const receitas = receitasAtivas();
  if (receitas.length === 0) {
    console.warn('[CONCILIA] Nenhuma receita configurada no .env (RECEITA_CODIGO_PERMISSIONARIO/RECEITA_CODIGO_EVENTO).');
    return;
  }

  // Define os limites do período: do primeiro dia do mês até hoje.
  const hoje = new Date();
  const primeiroDiaDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const ultimoDiaParaBuscar = hoje;

  let totalEncontrados = 0;
  let totalAtualizados = 0;

  // --- LÓGICA DE LOOP DIÁRIO ADICIONADA ---
  // Loop que itera dia a dia, do início do mês até a data atual.
  for (let diaCorrente = new Date(primeiroDiaDoMes); diaCorrente <= ultimoDiaParaBuscar; diaCorrente.setDate(diaCorrente.getDate() + 1)) {
    
    // Formata as datas para o dia específico dentro do loop
    const dataDia = ymd(diaCorrente);
    const dtIniDia = toDateTimeISO(diaCorrente, 0, 0, 0);
    const dtFimDia = toDateTimeISO(diaCorrente, 23, 59, 59);

    for (const cod of receitas) {
      console.log(`[CONCILIA] Buscando pagamentos de ${dataDia} para receita ${cod}...`);

      let itens = [];
      try {
        // Usa as variáveis do dia para a consulta
        itens = await listarPagamentosPorDataArrecadacao(dataDia, dataDia, cod);
      } catch (e) {
        console.warn(`[CONCILIA] Falha no por-data-arrecadacao: ${e.message || e}`);
      }

      if (!Array.isArray(itens) || itens.length === 0) {
        try {
          // Usa as variáveis do dia para a consulta
          itens = await listarPagamentosPorDataInclusao(dtIniDia, dtFimDia, cod);
        } catch (e) {
          console.warn(`[CONCILIA] Falha no por-data-inclusao: ${e.message || e}`);
        }
      }

      if (itens.length > 0) {
          console.log(`[CONCILIA] Receita ${cod} em ${dataDia}: retornados ${itens.length} registros.`);
      }

      for (const it of itens) {
        const numero = String(it.numeroGuia || '').trim();
        if (!numero) continue;

        totalEncontrados += 1;

        // 1) Tenta por numero_documento (caminho oficial)
        const r1 = await dbRun(
          `UPDATE dars
              SET status = 'Pago',
                  data_pagamento = COALESCE(?, data_pagamento)
            WHERE numero_documento = ?`,
          [it.dataPagamento || null, numero]
        );
        if (r1?.changes > 0) {
          totalAtualizados += r1.changes;
          continue;
        }

        // 2) Fallback: legado sem numero_documento -> usa codigo_barras
        const r2 = await dbRun(
          `UPDATE dars
              SET status = 'Pago',
                  data_pagamento = COALESCE(?, data_pagamento),
                  numero_documento = COALESCE(numero_documento, codigo_barras)
            WHERE codigo_barras = ?
              AND (numero_documento IS NULL OR numero_documento = '')`,
          [it.dataPagamento || null, numero]
        );
        if (r2?.changes > 0) {
          totalAtualizados += r2.changes;
          continue;
        }

        // 3) Em alguns retornos o campo que “bate” é a linha digitável.
        const r3 = await dbRun(
          `UPDATE dars
              SET status = 'Pago',
                  data_pagamento = COALESCE(?, data_pagamento)
            WHERE linha_digitavel = ?`,
          [it.dataPagamento || null, numero]
        );
        if (r3?.changes > 0) {
          totalAtualizados += r3.changes;
        }
      }
    }
  }

  console.log(`[CONCILIA] Finalizado. Registros retornados no período todo: ${totalEncontrados}. DARs atualizados: ${totalAtualizados}.`);
}
