document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('authToken');
    if (!token) { window.location.href = '/login.html'; return; }
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const navLink = document.querySelector('a[href="/salas.html"]');
    if (navLink) navLink.classList.add('active');

    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.addEventListener('click', (e) => {
            e.preventDefault();
            localStorage.removeItem('authToken');
            window.location.href = '/login.html';
        });
    }

    try {
        const response = await fetch('/api/user/me', { headers });
        if (response.ok) {
            const userData = await response.json();
            document.getElementById('userName').innerText = userData.nome_empresa;
            document.getElementById('userCnpj').innerText = formatarCNPJ(userData.cnpj);
        }
    } catch {}

    // Carrega salas disponíveis para o select
    const salaSelect = document.getElementById('sala');
    const submitBtn = document.querySelector('#reserveForm button[type="submit"]');
    submitBtn.disabled = true;
    try {
        const respSalas = await fetch('/api/salas', { headers });
        if (!respSalas.ok) throw new Error(`Status ${respSalas.status}`);
        const salas = await respSalas.json();
        if (!salas.length) {
            salaSelect.innerHTML = '<option value="">Nenhuma sala disponível</option>';
            alert('Nenhuma sala disponível');
            console.warn('Nenhuma sala disponível');
        } else {
            salas.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.nome;
                salaSelect.appendChild(opt);
            });
            submitBtn.disabled = false;
        }
    } catch (err) {
        console.error('Erro ao carregar salas', err);
        salaSelect.innerHTML = '<option value="">Nenhuma sala disponível</option>';
        alert('Erro ao carregar salas');
    }

    function gerarSlotsLivres(intervalos, data) {
        const inicioDia = '08:00';
        const fimDia = '18:00';
        const toMin = t => parseInt(t.slice(0,2),10)*60 + parseInt(t.slice(3,5),10);
        const toStr = m => String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
        const ocup = (intervalos || []).map(i => ({ ini: toMin(i.inicio), fim: toMin(i.fim) })).sort((a,b) => a.ini-b.ini);
        const livres = [];
        let cursor = toMin(inicioDia);
        const fimTotal = toMin(fimDia);
        ocup.forEach(i => {
            if (cursor < i.ini) {
                let start = cursor;
                while (start + 60 <= i.ini) {
                    livres.push({
                        inicio: `${data}T${toStr(start)}`,
                        fim: `${data}T${toStr(start + 60)}`
                    });
                    start += 60;
                }
            }
            if (cursor < i.fim) cursor = i.fim;
        });
        while (cursor + 60 <= fimTotal) {
            livres.push({
                inicio: `${data}T${toStr(cursor)}`,
                fim: `${data}T${toStr(cursor + 60)}`
            });
            cursor += 60;
        }
        return livres;
    }

    const calendarEl = document.getElementById('calendar');
    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'pt-br',
        themeSystem: 'bootstrap5',
        dateClick: info => {
            calendar.changeView('timeGridDay', info.dateStr);
        },
        eventClick: info => {
            if (info.event.extendedProps && info.event.extendedProps.livre) {
                document.getElementById('start').value = info.event.start.toISOString().slice(0,16);
                document.getElementById('end').value = info.event.end.toISOString().slice(0,16);
            }
        },
        events: async (info, successCallback, failureCallback) => {
            const salaId = salaSelect.value;
            if (!salaId) { successCallback([]); return; }
            try {
                const inicio = info.start.toISOString().slice(0,10);
                const fimDate = new Date(info.end); fimDate.setDate(fimDate.getDate() - 1);
                const fim = fimDate.toISOString().slice(0,10);
                const resp = await fetch(`/api/salas/${salaId}/reservas?inicio=${inicio}&fim=${fim}`, { headers });
                if (!resp.ok) throw new Error('Falha ao carregar reservas');
                const reservas = await resp.json();
                const eventos = reservas.map(r => ({
                    title: 'Reservado',
                    start: r.inicio,
                    end: r.fim,
                    backgroundColor: '#dc3545',
                    borderColor: '#dc3545'
                }));
                if (calendar.view.type === 'timeGridDay') {
                    try {
                        const respDisp = await fetch(`/api/salas/${salaId}/disponibilidade?data=${inicio}`, { headers });
                        if (respDisp.ok) {
                            const ocupados = await respDisp.json();
                            const livres = gerarSlotsLivres(ocupados, inicio);
                            livres.forEach(s => eventos.push({
                                title: 'Disponível',
                                start: s.inicio,
                                end: s.fim,
                                backgroundColor: '#198754',
                                borderColor: '#198754',
                                extendedProps: { livre: true }
                            }));
                        }
                    } catch {}
                }
                successCallback(eventos);
            } catch (err) {
                failureCallback(err);
            }
        }
    });
    calendar.render();
    salaSelect.addEventListener('change', () => calendar.refetchEvents());

    document.getElementById('reserveForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const sala_id = salaSelect.value;
        const start = document.getElementById('start').value;
        const end = document.getElementById('end').value;
        const qtd_pessoas = parseInt(document.getElementById('qtd_pessoas').value, 10);
        const data = start.split('T')[0];
        const horario_inicio = start.split('T')[1];
        const horario_fim = end.split('T')[1];
        try {
            const res = await fetch('/api/salas/reservas', {
                method: 'POST',
                headers,
                body: JSON.stringify({ sala_id, data, horario_inicio, horario_fim, qtd_pessoas })
            });
            if (!res.ok) throw new Error('Erro ao reservar');
            calendar.refetchEvents();
            carregarReservas();
            e.target.reset();
        } catch (err) {
            alert(err.message);
        }
    });

    const reservasBody = document.querySelector('#reservasTable tbody');
    const reservasCards = document.getElementById('reservasCards');
    const reservasTableWrapper = document.getElementById('reservasTableWrapper');
    const usarCards = typeof __isMobile === 'function' && __isMobile();
    let reservasCache = [];

    if (usarCards) {
        reservasTableWrapper.classList.add('d-none');
        reservasCards.classList.remove('d-none');
    }

    async function carregarReservas() {
        try {
            const resp = await fetch('/api/salas/minhas-reservas', { headers });
            if (!resp.ok) throw new Error('Falha ao carregar reservas');
            const reservas = await resp.json();
            reservasCache = reservas;
            if (usarCards) {
                reservasCards.innerHTML = '';
                reservas.forEach(r => {
                    const card = document.createElement('div');
                    card.className = 'reserva-card';
                    card.innerHTML = `
                        <div class="reserva-sala">${r.sala}</div>
                        <div class="reserva-data">${r.data}</div>
                        <div class="reserva-horas">${r.hora_inicio} - ${r.hora_fim}</div>
                        <div class="reserva-actions">
                            <button class="btn btn-sm btn-secondary me-2" data-edit="${r.id}">Editar</button>
                            <button class="btn btn-sm btn-danger" data-id="${r.id}">Cancelar</button>
                        </div>`;
                    reservasCards.appendChild(card);
                });
            } else {
                reservasBody.innerHTML = '';
                reservas.forEach(r => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${r.sala}</td>
                        <td>${r.data}</td>
                        <td>${r.hora_inicio}</td>
                        <td>${r.hora_fim}</td>
                        <td><button class="btn btn-sm btn-secondary me-2" data-edit="${r.id}">Editar</button><button class="btn btn-sm btn-danger" data-id="${r.id}">Cancelar</button></td>`;
                    reservasBody.appendChild(tr);
                });
            }
        } catch (err) {
            if (usarCards) reservasCards.innerHTML = '';
            else reservasBody.innerHTML = '';
        }
    }

    function cancelHandler(e) {
        if (e.target.matches('button[data-id]')) {
            const id = e.target.getAttribute('data-id');
            (async () => {
                try {
                    const res = await fetch(`/api/salas/reservas/${id}`, { method: 'DELETE', headers });
                    if (!res.ok) {
                        let msg = 'Erro ao cancelar';
                        try {
                            const data = await res.json();
                            msg = data.error || data.message || msg;
                        } catch {}
                        throw new Error(msg);
                    }
                    let sucesso = 'Reserva cancelada';
                    try {
                        const data = await res.json();
                        sucesso = data.message || sucesso;
                    } catch {}
                    alert(sucesso);
                    calendar.refetchEvents();
                    carregarReservas();
                } catch (err) {
                    alert(err.message);
                }
            })();
        }
    }

    function editHandler(e) {
        if (e.target.matches('button[data-edit]')) {
            const id = e.target.getAttribute('data-edit');
            const reserva = reservasCache.find(r => String(r.id) === String(id));
            if (!reserva) return;
            const formHtml = `
                <form id="editReservaForm" class="p-3">
                    <div class="mb-3">
                        <label class="form-label">Início</label>
                        <input type="datetime-local" class="form-control" id="editStart" value="${reserva.data}T${reserva.hora_inicio}" required>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Fim</label>
                        <input type="datetime-local" class="form-control" id="editEnd" value="${reserva.data}T${reserva.hora_fim}" required>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Qtd. Pessoas</label>
                        <input type="number" class="form-control" id="editQtd" min="1" step="1" value="${reserva.participantes || ''}">
                    </div>
                    <div class="text-end">
                        <button type="submit" class="btn btn-primary">Salvar</button>
                    </div>
                </form>`;
            AppUI.sheet.show(formHtml);
            document.getElementById('editReservaForm').addEventListener('submit', async ev => {
                ev.preventDefault();
                const start = document.getElementById('editStart').value;
                const end = document.getElementById('editEnd').value;
                const qtd = document.getElementById('editQtd').value;
                const payload = {};
                if (start) {
                    payload.data = start.split('T')[0];
                    payload.horario_inicio = start.split('T')[1];
                }
                if (end) {
                    payload.horario_fim = end.split('T')[1];
                    if (!payload.data) payload.data = end.split('T')[0];
                }
                if (qtd) payload.qtd_pessoas = parseInt(qtd, 10);
                try {
                    const res = await fetch(`/api/salas/reservas/${id}`, {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) throw new Error('Erro ao atualizar');
                    calendar.refetchEvents();
                    carregarReservas();
                    AppUI.sheet.hide();
                } catch (err) {
                    alert(err.message);
                }
            });
        }
    }

    reservasBody.addEventListener('click', cancelHandler);
    reservasCards.addEventListener('click', cancelHandler);
    reservasBody.addEventListener('click', editHandler);
    reservasCards.addEventListener('click', editHandler);

    carregarReservas();
});

function formatarCNPJ(cnpj) {
    if (!cnpj) return '';
    const cnpjLimpo = cnpj.toString().replace(/\D/g, '');
    if (cnpjLimpo.length === 14) {
        return cnpjLimpo.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    return cnpj;
}

