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

    const calendarEl = document.getElementById('calendar');
    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'pt-br',
        events: async (info, successCallback, failureCallback) => {
            try {
                const res = await fetch('/api/reservas', { headers });
                if (!res.ok) throw new Error('Falha ao carregar reservas');
                const data = await res.json();
                successCallback(data);
            } catch (err) {
                failureCallback(err);
            }
        }
    });
    calendar.render();

    document.getElementById('reserveForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const sala = document.getElementById('sala').value;
        const start = document.getElementById('start').value;
        const end = document.getElementById('end').value;
        try {
            const res = await fetch('/api/reservas', {
                method: 'POST',
                headers,
                body: JSON.stringify({ sala, start, end })
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
            const res = await fetch(`/api/reservas/${id}`, {
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

