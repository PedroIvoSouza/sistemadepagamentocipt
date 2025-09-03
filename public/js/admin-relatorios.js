// public/js/admin-relatorios.js
window.addEventListener('DOMContentLoaded', () => {
  const btnDevedores = document.getElementById('btnRelatorioDevedores');
  if (btnDevedores) {
    btnDevedores.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/admin/relatorios/devedores');
        if (!resp.ok) throw new Error('Falha ao gerar relatório');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert('Erro ao gerar relatório de devedores.');
      }
    });
  }

  const btnDars = document.getElementById('btnRelatorioDars');
  if (btnDars) {
    btnDars.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/admin/relatorios/dars');
        if (resp.status === 404 || resp.status === 204) {
          alert('Nenhuma DAR encontrada.');
          return;
        }
        if (!resp.ok) throw new Error('Falha ao gerar relatório');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert('Erro ao gerar relatório de DARs.');
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
      try {
        const resp = await fetch(`/api/admin/relatorios/eventos-dars?dataInicio=${dataInicio}&dataFim=${dataFim}`);
        if (resp.status === 404 || resp.status === 204) {
          alert('Nenhuma DAR encontrada.');
          return;
        }
        if (!resp.ok) throw new Error('Falha ao gerar relatório');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error(err);
        alert('Erro ao gerar relatório de DARs de eventos.');
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

      btnPagamentos.disabled = true;
      const originalText = btnPagamentos.textContent;
      btnPagamentos.textContent = 'Carregando...';

      try {
        const resp = await fetch(`/api/admin/relatorios/pagamentos?mes=${mes}&ano=${ano}`);
        if (!resp.ok) throw new Error('Falha ao buscar relatório');
        const dados = await resp.json();

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
        alert('Erro ao buscar relatório de pagamentos.');
      } finally {
        btnPagamentos.disabled = false;
        btnPagamentos.textContent = originalText;
      }
    });
  }
});
