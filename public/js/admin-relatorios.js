// public/js/admin-relatorios.js
function toggleLoading(btn, on) {
  if (on) {
    if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Gerando…';
  } else {
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
    btn.disabled = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const btnDevedores = document.getElementById('btnRelatorioDevedores');
  if (btnDevedores) {
    btnDevedores.addEventListener('click', async () => {
      toggleLoading(btnDevedores, true);
      try {
        const resp = await fetch('/api/admin/relatorios/devedores');
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || 'Erro ao gerar relatório de devedores.');
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert(err.message);
      } finally {
        toggleLoading(btnDevedores, false);
      }
    });
  }

  const btnDars = document.getElementById('btnRelatorioDars');
  if (btnDars) {
    btnDars.addEventListener('click', async () => {
      toggleLoading(btnDars, true);
      try {
        const resp = await fetch('/api/admin/relatorios/dars');
        if (resp.status === 404 || resp.status === 204) {
          alert('Nenhuma DAR encontrada.');
          return;
        }
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || 'Erro ao gerar relatório de DARs.');
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert(err.message);
      } finally {
        toggleLoading(btnDars, false);
      }
    });
  }

  const btnEventosDars = document.getElementById('btnRelatorioEventosDars');
  if (btnEventosDars) {
    btnEventosDars.addEventListener('click', async () => {
      const dataInicio = document.getElementById('dataInicio').value;
      const dataFim = document.getElementById('dataFim').value;
      if (!dataInicio || !dataFim) {
        alert('Selecione o intervalo de datas.');
        return;
      }
      toggleLoading(btnEventosDars, true);
      try {
        const resp = await fetch(`/api/admin/relatorios/eventos-dars?dataInicio=${dataInicio}&dataFim=${dataFim}`);
        if (resp.status === 404 || resp.status === 204) {
          alert('Nenhuma DAR encontrada.');
          return;
        }
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || 'Erro ao gerar relatório de DARs de eventos.');
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert(err.message);
      } finally {
        toggleLoading(btnEventosDars, false);
      }
    });
  }

  const btnPagamentos = document.getElementById('btnRelatorioPagamentos');
  if (btnPagamentos) {
    btnPagamentos.addEventListener('click', async () => {
      const mesAno = document.getElementById('mesAno').value;
      if (!mesAno) {
        alert('Selecione o mês e o ano.');
        return;
      }
      const [ano, mes] = mesAno.split('-').map(Number);
      if (!ano || !mes) {
        alert('Data inválida.');
        return;
      }

      const secaoPagos = document.getElementById('secaoPagos');
      const secaoDevedores = document.getElementById('secaoDevedores');
      const tbodyPagos = document.querySelector('#tabelaPagos tbody');
      const tbodyDevedores = document.querySelector('#tabelaDevedores tbody');

      secaoPagos.style.display = 'none';
      secaoDevedores.style.display = 'none';
      tbodyPagos.innerHTML = '';
      tbodyDevedores.innerHTML = '';

      toggleLoading(btnPagamentos, true);
      try {
        const resp = await fetch(`/api/admin/relatorios/pagamentos?mes=${mes}&ano=${ano}`);
        const dados = await resp.json();
        if (!resp.ok) throw new Error(dados.error || 'Erro ao buscar relatório de pagamentos.');

        dados.pagos.forEach((item) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${item.nome_empresa}</td><td>${item.cnpj}</td><td>R$ ${Number(item.valor).toFixed(2)}</td>`;
          tbodyPagos.appendChild(tr);
        });
        dados.devedores.forEach((item) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${item.nome_empresa}</td><td>${item.cnpj}</td><td>R$ ${Number(item.valor).toFixed(2)}</td>`;
          tbodyDevedores.appendChild(tr);
        });

        if (dados.pagos.length) secaoPagos.style.display = 'block';
        if (dados.devedores.length) secaoDevedores.style.display = 'block';
      } catch (err) {
        console.error(err);
        alert(err.message);
      } finally {
        toggleLoading(btnPagamentos, false);
      }
    });
  }

  const btnComprovantes = document.getElementById('btnComprovantesMensais');
  if (btnComprovantes) {
    btnComprovantes.addEventListener('click', async () => {
      const mesAno = document.getElementById('mesAno').value;
      if (!mesAno) {
        alert('Selecione o mês e o ano.');
        return;
      }
      const [ano, mes] = mesAno.split('-').map(Number);
      if (!ano || !mes) {
        alert('Data inválida.');
        return;
      }
      toggleLoading(btnComprovantes, true);
      try {
        const resp = await fetch(`/api/admin/relatorios/comprovantes?mes=${mes}&ano=${ano}`);
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || 'Erro ao gerar comprovantes.');
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert(err.message);
      } finally {
        toggleLoading(btnComprovantes, false);
      }
    });
  }
});
