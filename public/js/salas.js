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

    const calendarEl = document.getElementById('calendar');
    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'pt-br',
        themeSystem: 'bootstrap5',
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

