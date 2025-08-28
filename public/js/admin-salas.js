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
  }

  carregarSalas();
});

async function fetchReservas(fetchInfo, successCallback, failureCallback) {
  try {
    const resp = await fetch('/api/admin/salas/reservas');
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
  const acao = prompt('Digite "c" para cancelar ou "u" para registrar check-in:');
  if (acao === 'c') {
    fetch(`/api/admin/salas/reservas/${info.event.id}`, { method: 'DELETE' })
      .then(resp => {
        if (resp.ok) info.event.remove();
        else alert('Falha ao cancelar reserva');
      });
  } else if (acao === 'u') {
    fetch(`/api/admin/salas/reservas/${info.event.id}/checkin`, { method: 'POST' })
      .then(resp => {
        if (resp.ok) alert('Check-in registrado');
        else alert('Falha ao registrar check-in');
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
  if (!tabela) return;
  try {
    const resp = await fetch('/api/admin/salas');
    if (!resp.ok) throw new Error('Falha ao carregar salas');
    const salas = await resp.json();
    salas.forEach(sala => {
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
