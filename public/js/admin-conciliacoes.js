(function () {
  const numberFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  const formatDate = (value) => {
    if (!value) return '—';
    const raw = String(value).trim();
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('pt-BR');
    }
    const onlyDate = raw.split(' ')[0];
    const [ano, mes, dia] = onlyDate.split('-');
    if (ano && mes && dia) {
      return `${dia}/${mes}/${ano}`;
    }
    return raw || '—';
  };

  const formatDateTime = (value) => {
    if (!value) return '—';
    const raw = String(value).trim();
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) {
      return (
        date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
        ' ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      );
    }
    const [dia, hora] = raw.split(' ');
    if (dia) {
      return `${formatDate(dia)} ${hora || ''}`.trim();
    }
    return raw;
  };

  const formatDuration = (ms) => {
    if (ms == null || Number.isNaN(ms)) return '—';
    const totalMs = Number(ms);
    if (!Number.isFinite(totalMs) || totalMs <= 0) return '—';
    const seconds = Math.round(totalMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  };

  const formatCurrency = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '—';
    try { return numberFormatter.format(Number(value)); } catch (_) { return '—'; }
  };

  document.addEventListener('DOMContentLoaded', () => {
    let token = localStorage.getItem('adminToken') || localStorage.getItem('adminAuthToken');
    if (!token) {
      window.location.href = '/admin/login.html';
      return;
    }
    localStorage.setItem('adminToken', token);
    localStorage.removeItem('adminAuthToken');

    try {
      const base64url = token.split('.')[1] || '';
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
      const payload = JSON.parse(atob(base64));
      const adminNameEl = document.getElementById('adminName');
      if (adminNameEl) adminNameEl.textContent = payload?.nome || 'Administrador';
    } catch (error) {
      console.error('Erro ao decodificar token de administrador:', error);
    }

    const headers = { Authorization: `Bearer ${token}` };

    const cardsResumo = document.getElementById('cardsResumo');
    const tabelaConciliacoes = document.querySelector('#tabelaConciliacoes tbody');
    const totalLabel = document.getElementById('conciliacoesTotal');
    const detalhesSubtitulo = document.getElementById('detalhesSubtitulo');
    const detalhesQuantidade = document.getElementById('detalhesQuantidade');
    const detalhesTabelaBody = document.querySelector('#tabelaPagamentos tbody');
    const detalhesTabelaWrapper = document.getElementById('detalhesTabelaWrapper');
    const detalhesVazio = document.getElementById('detalhesVazio');
    const pendentesWrapper = document.getElementById('pendentesWrapper');
    const pendentesQuantidade = document.getElementById('pendentesQuantidade');
    const pendentesTabelaWrapper = document.getElementById('pendentesTabelaWrapper');
    const pendentesTabelaBody = document.querySelector('#tabelaPagamentosPendentes tbody');
    const pendentesVazio = document.getElementById('pendentesVazio');
    const refreshButton = document.getElementById('btnRecarregar');

    let conciliacoes = [];
    let selecionadoId = null;
    const detalhesCache = new Map();

    const buildStatusBadge = (status) => {
      const statusLower = String(status || '').toLowerCase();
      let cls = 'bg-secondary-subtle text-secondary';
      let label = status || '—';
      if (statusLower === 'sucesso') {
        cls = 'bg-success-subtle text-success';
        label = 'Sucesso';
      } else if (statusLower === 'falha') {
        cls = 'bg-danger-subtle text-danger';
        label = 'Falha';
      }
      return `<span class="badge badge-status ${cls}">${label}</span>`;
    };

    const renderResumo = (registro) => {
      if (!cardsResumo) return;
      if (!registro) {
        cardsResumo.innerHTML = `
          <div class="col-12">
            <div class="empty-placeholder">Nenhuma execução registrada até o momento.</div>
          </div>`;
        return;
      }

      const partes = [
        {
          titulo: 'Data de referência',
          valor: formatDate(registro.data_referencia),
          icone: 'calendar-event'
        },
        {
          titulo: 'Pagamentos atualizados',
          valor: `${registro.total_atualizados}/${registro.total_pagamentos}`,
          icone: 'check2-circle'
        },
        {
          titulo: 'Status',
          valor: String(registro.status || '—').replace(/^./, (c) => c.toUpperCase()),
          icone: registro.status === 'sucesso' ? 'check-circle-fill' : 'exclamation-triangle-fill'
        }
      ];

      cardsResumo.innerHTML = partes.map((item) => `
        <div class="col-12 col-md-4">
          <div class="resumo-card h-100">
            <div class="d-flex align-items-center gap-3">
              <div class="text-primary fs-3"><i class="bi bi-${item.icone}"></i></div>
              <div>
                <h6 class="text-muted text-uppercase mb-1">${item.titulo}</h6>
                <div class="fs-5 fw-semibold">${item.valor}</div>
              </div>
            </div>
          </div>
        </div>
      `).join('');
    };

    const renderConciliacoes = () => {
      if (!tabelaConciliacoes) return;
      if (!Array.isArray(conciliacoes) || !conciliacoes.length) {
        tabelaConciliacoes.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">Nenhuma conciliação registrada.</td></tr>`;
        return;
      }

      tabelaConciliacoes.innerHTML = conciliacoes.map((registro) => {
        const ativo = registro.id === selecionadoId ? 'active' : '';
        const execucao = registro.data_execucao ? formatDateTime(registro.data_execucao) : '—';
        const referencia = formatDate(registro.data_referencia);
        const duracao = formatDuration(registro.duracao_ms);
        return `
          <tr data-id="${registro.id}" class="${ativo}">
            <td>${referencia}</td>
            <td>${execucao}</td>
            <td class="text-center">${registro.total_pagamentos}</td>
            <td class="text-center">${registro.total_atualizados}</td>
            <td class="text-center">${duracao}</td>
            <td class="text-center">${buildStatusBadge(registro.status)}</td>
          </tr>
        `;
      }).join('');

      tabelaConciliacoes.querySelectorAll('tr[data-id]').forEach((row) => {
        row.addEventListener('click', () => {
          const id = Number(row.getAttribute('data-id'));
          selecionarConciliacao(id);
        });
      });
    };

    const renderPagamentos = (lista) => {
      if (!detalhesTabelaBody || !detalhesTabelaWrapper || !detalhesVazio) return;
      if (!Array.isArray(lista) || !lista.length) {
        detalhesTabelaWrapper.classList.add('d-none');
        detalhesVazio.classList.remove('d-none');
        detalhesTabelaBody.innerHTML = '';
        return;
      }

      detalhesTabelaWrapper.classList.remove('d-none');
      detalhesVazio.classList.add('d-none');

      detalhesTabelaBody.innerHTML = lista.map((item) => {
        const contribuinteParts = [item.contribuinte, item.documento_contribuinte].filter(Boolean);
        if (!contribuinteParts.length && item.pagamento?.documento) {
          contribuinteParts.push(item.pagamento.documento);
        }
        const contribuinte = contribuinteParts.join(' • ');
        const pagamentoInfo = [
          item.pagamento?.data ? formatDate(item.pagamento.data) : null,
          item.pagamento?.guia ? `Guia ${item.pagamento.guia}` : null,
          item.pagamento?.codigo_barras ? `Código de barras ${item.pagamento.codigo_barras}` : null,
          item.pagamento?.linha_digitavel ? `Linha digitável ${item.pagamento.linha_digitavel}` : null,
          item.pagamento?.valor != null ? formatCurrency(item.pagamento.valor) : null,
        ].filter(Boolean).join('<br>');
        const numeroDar = item.numero_documento || (item.dar_id ? `DAR #${item.dar_id}` : '—');
        const valor = item.valor != null ? formatCurrency(item.valor) : '—';
        const statusAnterior = item.status_anterior || '—';
        const origemBadge = item.origem ? `<span class="badge bg-light text-secondary border">${item.origem}</span>` : '';

        return `
          <tr>
            <td><div class="fw-semibold">${numeroDar}</div>${origemBadge ? `<div class="small text-muted mt-1">${origemBadge}</div>` : ''}</td>
            <td>${contribuinte || '—'}</td>
            <td>${valor}</td>
            <td>${pagamentoInfo || '—'}</td>
            <td>${statusAnterior}</td>
          </tr>
        `;
      }).join('');
    };

    const renderPendentes = (lista, mostrar) => {
      if (!pendentesWrapper || !pendentesTabelaWrapper || !pendentesTabelaBody || !pendentesVazio) return;
      if (!mostrar) {
        pendentesWrapper.classList.add('d-none');
        pendentesTabelaWrapper.classList.add('d-none');
        pendentesVazio.classList.add('d-none');
        pendentesTabelaBody.innerHTML = '';
        if (pendentesQuantidade) pendentesQuantidade.textContent = '';
        return;
      }

      pendentesWrapper.classList.remove('d-none');
      const listaValida = Array.isArray(lista) ? lista : [];
      if (!listaValida.length) {
        pendentesTabelaWrapper.classList.add('d-none');
        pendentesVazio.classList.remove('d-none');
        pendentesTabelaBody.innerHTML = '';
        if (pendentesQuantidade) pendentesQuantidade.textContent = '0 pendentes';
        return;
      }

      pendentesTabelaWrapper.classList.remove('d-none');
      pendentesVazio.classList.add('d-none');
      if (pendentesQuantidade) {
        pendentesQuantidade.textContent = `${listaValida.length} pendente${listaValida.length === 1 ? '' : 's'}`;
      }

      pendentesTabelaBody.innerHTML = listaValida.map((item) => {
        const pagamento = item.pagamento || {};
        const refs = [
          pagamento.guia ? `Guia ${pagamento.guia}` : null,
          pagamento.codigo_barras ? `Código de barras ${pagamento.codigo_barras}` : null,
          pagamento.linha_digitavel ? `Linha digitável ${pagamento.linha_digitavel}` : null,
        ].filter(Boolean).join('<br>');
        const documento = pagamento.documento || '—';
        const valor = pagamento.valor != null ? formatCurrency(pagamento.valor) : '—';
        const data = pagamento.data ? formatDateTime(pagamento.data) : '—';
        const observacao = item.observacao || '—';

        return `
          <tr>
            <td>${refs || '—'}</td>
            <td>${documento}</td>
            <td>${valor}</td>
            <td>${data}</td>
            <td>${observacao}</td>
          </tr>
        `;
      }).join('');
    };

    const atualizarDetalhes = (registro, detalhes) => {
      if (detalhesSubtitulo) {
        if (registro) {
          const quando = registro.data_execucao ? formatDateTime(registro.data_execucao) : formatDate(registro.data_referencia);
          detalhesSubtitulo.textContent = `Execução de ${quando}.`;
        } else {
          detalhesSubtitulo.textContent = 'Selecione uma execução para visualizar os pagamentos atualizados.';
        }
      }
      if (detalhesQuantidade) {
        if (registro) {
          const conciliados = Array.isArray(detalhes?.pagamentos) ? detalhes.pagamentos.length : 0;
          const pendentes = Array.isArray(detalhes?.pendentes) ? detalhes.pendentes.length : 0;
          const partes = [`${conciliados} conciliado${conciliados === 1 ? '' : 's'}`];
          partes.push(`${pendentes} pendente${pendentes === 1 ? '' : 's'}`);
          detalhesQuantidade.textContent = partes.join(' · ');
        } else {
          detalhesQuantidade.textContent = '';
        }
      }
      const listaConciliados = Array.isArray(detalhes?.pagamentos) ? detalhes.pagamentos : [];
      const listaPendentes = Array.isArray(detalhes?.pendentes) ? detalhes.pendentes : [];
      renderPagamentos(listaConciliados);
      renderPendentes(listaPendentes, Boolean(registro));
      if (pendentesQuantidade && registro && !listaPendentes.length) {
        pendentesQuantidade.textContent = '0 pendentes';
      }
    };

    const selecionarConciliacao = async (id) => {
      if (!id) return;
      const registro = conciliacoes.find((item) => item.id === id);
      if (!registro) return;
      selecionadoId = id;
      renderConciliacoes();
      renderResumo(registro);

      try {
        let detalhes = detalhesCache.get(id);
        if (!detalhes) {
          const response = await fetch(`/api/admin/dars/conciliacoes/${id}/pagamentos`, { headers });
          if (!response.ok) throw new Error('Falha ao carregar detalhes da conciliação.');
          detalhes = await response.json();
          detalhesCache.set(id, detalhes);
        }
        atualizarDetalhes(registro, detalhes);
      } catch (error) {
        console.error('Detalhes da conciliação:', error);
        atualizarDetalhes(registro, { pagamentos: [], pendentes: [] });
        if (detalhesSubtitulo) {
          detalhesSubtitulo.textContent = error.message || 'Erro ao carregar os pagamentos conciliados.';
        }
      }
    };

    const carregarConciliacoes = async () => {
      try {
        const response = await fetch('/api/admin/dars/conciliacoes?limit=25', { headers });
        if (!response.ok) throw new Error('Não foi possível carregar as conciliações.');
        const data = await response.json();
        conciliacoes = Array.isArray(data?.registros) ? data.registros : [];
        detalhesCache.clear();
        selecionadoId = null;

        if (totalLabel) {
          const total = Number(data?.total || conciliacoes.length || 0);
          totalLabel.textContent = total ? `${total} registro${total === 1 ? '' : 's'}` : 'Nenhum registro';
        }

        renderConciliacoes();
        const primeiro = conciliacoes[0];
        if (primeiro) {
          await selecionarConciliacao(primeiro.id);
        } else {
          renderResumo(null);
          atualizarDetalhes(null, { pagamentos: [], pendentes: [] });
        }
      } catch (error) {
        console.error('Histórico de conciliações:', error);
        if (tabelaConciliacoes) {
          tabelaConciliacoes.innerHTML = `<tr><td colspan="6" class="text-center text-danger py-4">${error.message || 'Erro ao carregar conciliações.'}</td></tr>`;
        }
        renderResumo(null);
        atualizarDetalhes(null, { pagamentos: [], pendentes: [] });
        if (totalLabel) totalLabel.textContent = '';
      }
    };

    if (refreshButton) {
      refreshButton.addEventListener('click', () => carregarConciliacoes());
    }

    carregarConciliacoes();
  });
})();
