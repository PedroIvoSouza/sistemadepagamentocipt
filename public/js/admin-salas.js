// public/js/admin-salas.js

let modalReserva;
let modalNovaSala;
let modalNovaReserva;
let eventoSelecionado;

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

  const modalEl = document.getElementById('modalReserva');
  if (modalEl && window.bootstrap) {
    modalReserva = new bootstrap.Modal(modalEl);
    const btnCanc = document.getElementById('btnCancelarReserva');
    const btnCheck = document.getElementById('btnRegistrarCheckin');
    btnCanc?.addEventListener('click', cancelarReserva);
    btnCheck?.addEventListener('click', registrarCheckin);
  }

  const modalNovaSalaEl = document.getElementById('modalNovaSala');
  if (modalNovaSalaEl && window.bootstrap) {
    modalNovaSala = new bootstrap.Modal(modalNovaSalaEl);
  }

  const modalNovaReservaEl = document.getElementById('modalNovaReserva');
  if (modalNovaReservaEl && window.bootstrap) {
    modalNovaReserva = new bootstrap.Modal(modalNovaReservaEl);
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
  eventoSelecionado = info.event;
  modalReserva?.show();
}

async function cancelarReserva() {
  if (!eventoSelecionado) return;
  try {
    const resp = await fetch(`/api/admin/salas/reservas/${eventoSelecionado.id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error('Falha ao cancelar reserva');
    eventoSelecionado.remove();
    mostrarMensagem('Reserva cancelada com sucesso', 'success');
  } catch (err) {
    console.error(err);
    mostrarMensagem('Falha ao cancelar reserva', 'danger');
  } finally {
    modalReserva.hide();
  }
}

async function registrarCheckin() {
  if (!eventoSelecionado) return;
  try {
    const resp = await fetch(`/api/admin/salas/reservas/${eventoSelecionado.id}/uso`, { method: 'POST' });
    if (!resp.ok) throw new Error('Falha ao registrar check-in');
    mostrarMensagem('Check-in registrado com sucesso', 'success');
  } catch (err) {
    console.error(err);
    mostrarMensagem('Falha ao registrar check-in', 'danger');
  } finally {
    modalReserva.hide();
  }
}

function mostrarMensagem(texto, tipo = 'success') {
  const el = document.getElementById('mensagem');
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${tipo}" role="alert">${texto}</div>`;
  setTimeout(() => {
    el.innerHTML = '';
  }, 4000);
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
  try {
    const resp = await fetch('/api/admin/salas');
    if (!resp.ok) throw new Error('Falha ao carregar salas');
    const salas = await resp.json();
    salas.forEach(s => adicionarSalaUI(s));
  } catch (err) {
    console.error(err);
  }
}

function adicionarSalaUI(sala) {
  const tabela = document.querySelector('#tabelaSalas tbody');
  const selectSala = document.getElementById('filtroSala');
  const selectReservaSala = document.getElementById('reservaSala');

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
  if (selectReservaSala) {
    const opt2 = document.createElement('option');
    opt2.value = sala.id;
    opt2.textContent = sala.nome;
    selectReservaSala.appendChild(opt2);
  }
}

async function carregarPermissionarios() {
  try {
    const resp = await fetch('/api/admin/permissionarios?limit=1000');
    if (!resp.ok) throw new Error('Falha ao carregar permissionários');
    const dados = await resp.json();
    const lista = dados.permissionarios || [];
    const select = document.getElementById('reservaPermissionario');
    if (select) {
      select.innerHTML = '';
      lista.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.nome_empresa;
        select.appendChild(opt);
      });
    }
  } catch (err) {
    console.error(err);
  }
}

function abrirModalNovaSala() {
  const numero = document.getElementById('novaSalaNumero');
  const capacidade = document.getElementById('novaSalaCapacidade');
  const status = document.getElementById('novaSalaStatus');
  if (numero) numero.value = '';
  if (capacidade) capacidade.value = '';
  if (status) status.value = 'disponivel';
  modalNovaSala?.show();
}

function abrirModalNovaReserva() {
  const fields = ['reservaSala', 'reservaPermissionario', 'reservaData', 'reservaInicio', 'reservaFim', 'reservaQtdPessoas'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  carregarPermissionarios();
  modalNovaReserva?.show();
}

async function salvarNovaReserva() {
  const salaId = document.getElementById('reservaSala')?.value;
  const permissionarioId = document.getElementById('reservaPermissionario')?.value;
  const data = document.getElementById('reservaData')?.value;
  const inicio = document.getElementById('reservaInicio')?.value;
  const fim = document.getElementById('reservaFim')?.value;
  const qtd = parseInt(document.getElementById('reservaQtdPessoas')?.value || '0', 10);

  if (!salaId || !permissionarioId || !data || !inicio || !fim) {
    mostrarMensagem('Preencha todos os campos obrigatórios', 'danger');
    return;
  }

  try {
    const resp = await fetch('/api/admin/salas/reservas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sala_id: parseInt(salaId, 10),
        permissionario_id: parseInt(permissionarioId, 10),
        data,
        horario_inicio: inicio,
        horario_fim: fim,
        qtd_pessoas: isNaN(qtd) ? 0 : qtd
      })
    });
    if (!resp.ok) throw new Error('Falha ao criar reserva');
    mostrarMensagem('Reserva criada com sucesso', 'success');
    modalNovaReserva.hide();
    window._salasCalendar?.refetchEvents();
  } catch (err) {
    console.error(err);
    mostrarMensagem('Falha ao criar reserva', 'danger');
  }
}

async function salvarNovaSala() {
  const numeroEl = document.getElementById('novaSalaNumero');
  const capacidadeEl = document.getElementById('novaSalaCapacidade');
  const statusEl = document.getElementById('novaSalaStatus');
  const numero = numeroEl?.value.trim();
  const capacidade = parseInt(capacidadeEl?.value, 10);
  const status = statusEl?.value || 'disponivel';

  if (!numero || isNaN(capacidade)) {
    mostrarMensagem('Preencha todos os campos', 'danger');
    return;
  }

  try {
    const resp = await fetch('/api/admin/salas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero, capacidade, status })
    });
    if (!resp.ok) throw new Error('Falha ao criar sala');
    const sala = await resp.json();

    adicionarSalaUI({
      id: sala.id,
      nome: sala.nome || sala.numero || numero,
      status: sala.status || status
    });

    modalNovaSala.hide();
    numeroEl.value = '';
    capacidadeEl.value = '';
    statusEl.value = 'disponivel';
    mostrarMensagem('Sala criada com sucesso', 'success');
  } catch (err) {
    console.error(err);
    mostrarMensagem('Falha ao criar sala', 'danger');
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
