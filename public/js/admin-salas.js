// public/js/admin-salas.js

document.addEventListener('DOMContentLoaded', () => {
  const calendarEl = document.getElementById('calendar');
  if (calendarEl && window.FullCalendar) {
    const calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: 'dayGridMonth',
      locale: 'pt-br',
      editable: true,
      eventSources: [fetchReservas],
      eventClick: onEventClick,
      eventDrop: onEventChange,
      eventResize: onEventChange
    });
    calendar.render();
    window._salasCalendar = calendar;

    ['filtroSala', 'filtroDataInicio', 'filtroDataFim'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => calendar.refetchEvents());
    });
  }

  carregarSalas();
});

async function fetchReservas(fetchInfo, successCallback, failureCallback) {
  try {
    const params = new URLSearchParams({
      salaId: document.getElementById('filtroSala')?.value || '',
      dataInicio: document.getElementById('filtroDataInicio')?.value || '',
      dataFim: document.getElementById('filtroDataFim')?.value || ''
    });
    const resp = await fetch(`/api/admin/salas/reservas?${params.toString()}`);
    if (!resp.ok) throw new Error('Falha ao carregar reservas');
    const dados = await resp.json();
    const eventos = dados.map(r => ({
      id: r.id,
      title: r.sala_nome,
      start: r.inicio,
      end: r.fim
    }));
    successCallback(eventos);
  } catch (err) {
    console.error(err);
    failureCallback(err);
  }
}

function onEventClick(info) {
  const acao = prompt('Digite "c" para cancelar ou "u" para registrar uso:');
  if (acao === 'c') {
    fetch(`/api/admin/salas/reservas/${info.event.id}`, { method: 'DELETE' })
      .then(resp => {
        if (resp.ok) info.event.remove();
        else alert('Falha ao cancelar reserva');
      });
  } else if (acao === 'u') {
    fetch(`/api/admin/salas/reservas/${info.event.id}/uso`, { method: 'POST' })
      .then(resp => {
        if (resp.ok) alert('Uso registrado');
        else alert('Falha ao registrar uso');
      });
  }
}

function onEventChange(info) {
  fetch(`/api/admin/salas/reservas/${info.event.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inicio: info.event.start ? info.event.start.toISOString() : null,
      fim: info.event.end ? info.event.end.toISOString() : null
    })
  }).then(resp => {
    if (!resp.ok) alert('Falha ao atualizar reserva');
  }).catch(err => {
    console.error(err);
    alert('Erro de rede ao atualizar reserva');
  });
}

async function carregarSalas() {
  const tabela = document.querySelector('#tabelaSalas tbody');
  const selectSala = document.getElementById('filtroSala');
  try {
    const resp = await fetch('/api/admin/salas');
    if (!resp.ok) throw new Error('Falha ao carregar salas');
    const salas = await resp.json();
    salas.forEach(sala => {
      if (tabela) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${sala.nome}</td>
          <td><input type="checkbox" class="chk-disponivel" ${sala.status === 'disponivel' ? 'checked' : ''}></td>
          <td><input type="checkbox" class="chk-manutencao" ${sala.status === 'manutencao' ? 'checked' : ''}></td>`;
        tabela.appendChild(tr);
        const chkDisp = tr.querySelector('.chk-disponivel');
        const chkManu = tr.querySelector('.chk-manutencao');
        chkDisp.addEventListener('change', () => {
          if (chkDisp.checked) chkManu.checked = false;
          const status = chkDisp.checked
            ? 'disponivel'
            : chkManu.checked
              ? 'manutencao'
              : 'indisponivel';
          atualizarSala(sala.id, status);
        });
        chkManu.addEventListener('change', () => {
          if (chkManu.checked) chkDisp.checked = false;
          const status = chkManu.checked
            ? 'manutencao'
            : chkDisp.checked
              ? 'disponivel'
              : 'indisponivel';
          atualizarSala(sala.id, status);
        });
      }

      if (selectSala) {
        const opt = document.createElement('option');
        opt.value = sala.id;
        opt.textContent = sala.nome;
        selectSala.appendChild(opt);
      }
    });
  } catch (err) {
    console.error(err);
  }
}

function atualizarSala(id, status) {
  fetch(`/api/admin/salas/${id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  }).then(resp => {
    if (!resp.ok) alert('Falha ao atualizar sala');
  }).catch(err => {
    console.error(err);
    alert('Erro de rede ao atualizar sala');
  });
}
