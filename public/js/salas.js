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
    try {
        const respSalas = await fetch('/api/salas', { headers });
        if (respSalas.ok) {
            const salas = await respSalas.json();
            salas.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.nome;
                salaSelect.appendChild(opt);
            });
        }
    } catch {}

    const calendarEl = document.getElementById('calendar');
    const HORARIOS_PADRAO = [
        '08:00','09:00','10:00','11:00','12:00',
        '13:00','14:00','15:00','16:00','17:00'
    ];
    const somaHora = h => {
        const [hr, min] = h.split(':').map(Number);
        const d = new Date(0,0,0,hr,min,0);
        d.setHours(d.getHours() + 1);
        return d.toTimeString().slice(0,5);
    };
    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'pt-br',
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
                const eventos = [];
                const reservasPorData = {};
                reservas.forEach(r => {
                    eventos.push({
                        title: 'Reservado',
                        start: r.inicio,
                        end: r.fim,
                        backgroundColor: '#dc3545',
                        borderColor: '#dc3545'
                    });
                    const data = r.inicio.split('T')[0];
                    if (!reservasPorData[data]) reservasPorData[data] = new Set();
                    let h = r.inicio.split('T')[1].slice(0,5);
                    const hf = r.fim.split('T')[1].slice(0,5);
                    while (h < hf) { reservasPorData[data].add(h); h = somaHora(h); }
                });

                for (let current = new Date(info.start); current < info.end; current.setDate(current.getDate()+1)) {
                    const dataStr = current.toISOString().slice(0,10);
                    const ocupados = reservasPorData[dataStr] || new Set();
                    HORARIOS_PADRAO.forEach(h => {
                        if (!ocupados.has(h)) {
                            const start = `${dataStr}T${h}`;
                            const fimDate2 = new Date(`${start}:00`);
                            fimDate2.setHours(fimDate2.getHours()+1);
                            eventos.push({
                                title: 'Disponível',
                                start,
                                end: fimDate2.toISOString().slice(0,16),
                                backgroundColor: '#198754',
                                borderColor: '#198754'
                            });
                        }
                    });
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
        if (qtd_pessoas < 3) {
            alert('A quantidade mínima de pessoas é 3.');
            return;
        }
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
    async function carregarReservas() {
        try {
            const resp = await fetch('/api/salas/minhas-reservas', { headers });
            if (!resp.ok) throw new Error('Falha ao carregar reservas');
            const reservas = await resp.json();
            reservasBody.innerHTML = '';
            reservas.forEach(r => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${r.sala}</td>
                    <td>${r.data}</td>
                    <td>${r.hora_inicio}</td>
                    <td>${r.hora_fim}</td>
                    <td><button class="btn btn-sm btn-danger" data-id="${r.id}">Cancelar</button></td>`;
                reservasBody.appendChild(tr);
            });
        } catch (err) {
            reservasBody.innerHTML = '';
        }
    }

    reservasBody.addEventListener('click', async (e) => {
        if (e.target.matches('button[data-id]')) {
            const id = e.target.getAttribute('data-id');
            try {
                const res = await fetch(`/api/salas/reservas/${id}`, { method: 'DELETE', headers });
                if (!res.ok) throw new Error('Erro ao cancelar');
                calendar.refetchEvents();
                carregarReservas();
            } catch (err) {
                alert(err.message);
            }
        }
    });

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

