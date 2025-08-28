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
    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'pt-br',
        events: async (info, successCallback, failureCallback) => {
            const salaId = salaSelect.value;
            if (!salaId) { successCallback([]); return; }
            try {
                const eventos = [];
                const current = new Date(info.start);
                while (current < info.end) {
                    const dataStr = current.toISOString().slice(0,10);
                    const resp = await fetch(`/api/salas/${salaId}/disponibilidade?data=${dataStr}`, { headers });
                    if (!resp.ok) throw new Error('Falha ao carregar disponibilidade');
                    const { horarios } = await resp.json();
                    horarios.forEach(h => {
                        const inicio = `${dataStr}T${h}`;
                        const fimDate = new Date(`${inicio}:00`);
                        fimDate.setHours(fimDate.getHours() + 1);
                        const fim = fimDate.toISOString().slice(0,16);
                        eventos.push({ title: 'Disponível', start: inicio, end: fim });
                    });
                    current.setDate(current.getDate() + 1);
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
            e.target.reset();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('cancelForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('reservaId').value;
        try {
            const res = await fetch(`/api/salas/reservas/${id}`, {
                method: 'DELETE',
                headers
            });
            if (!res.ok) throw new Error('Erro ao cancelar');
            calendar.refetchEvents();
            e.target.reset();
        } catch (err) {
            alert(err.message);
        }
    });
});

function formatarCNPJ(cnpj) {
    if (!cnpj) return '';
    const cnpjLimpo = cnpj.toString().replace(/\D/g, '');
    if (cnpjLimpo.length === 14) {
        return cnpjLimpo.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    return cnpj;
}

