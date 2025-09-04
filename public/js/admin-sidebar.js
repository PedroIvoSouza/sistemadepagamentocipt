// public/js/admin-sidebar.js
// Carrega o sidebar comum e aplica comportamento compartilhado

document.addEventListener('DOMContentLoaded', () => {
    // obtém token do admin e decodifica role
    const token = (typeof window.getAdminToken === 'function' && window.getAdminToken()) ||
        localStorage.getItem('adminToken') ||
        localStorage.getItem('adminAuthToken');

    const role = decodeRoleFromToken(token);

    const container = document.getElementById('sidebar-container');
    if (container) {
        fetch('/admin/admin-sidebar.html')
            .then(resp => {
                if (!resp.ok) throw new Error('Não foi possível carregar o sidebar');
                return resp.text();
            })
            .then(html => {
                container.outerHTML = html;
            })
            .then(() => {
                applyRoleToSidebar(role);
                initSidebarBehaviour();
            })
            .catch(err => console.error('Erro ao injetar sidebar:', err));
    } else {
        applyRoleToSidebar(role);
        initSidebarBehaviour(); // Sidebar já está no HTML
    }
});

function decodeRoleFromToken(token) {
    if (!token) return null;
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.role;
    } catch (err) {
        console.error('Erro ao decodificar token:', err);
        return null;
    }
}

function applyRoleToSidebar(role) {
    if (!role) return;

    // abordagem genérica: usa atributo data-roles se existir
    document.querySelectorAll('[data-roles]').forEach(item => {
        const roles = item.getAttribute('data-roles').split(',').map(r => r.trim());
        if (!roles.includes(role)) {
            item.remove();
        }
    });

    // fallback específico para SALAS_ADMIN usando href/classes
    if (role === 'SALAS_ADMIN') {
        const allowedSelectors = [
            '.nav-link[href*="dashboard.html"]',
            '.nav-link[href*="permissionarios.html"]',
            '.nav-link[href*="salas.html"]',
            '#logoutButton'
        ];

        document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
            const link = item.querySelector('.nav-link');
            if (!link) return;
            const allowed = allowedSelectors.some(sel => link.matches(sel));
            if (!allowed) item.remove();
        });
    }
}

function initSidebarBehaviour() {
    const currentPath = window.location.pathname;

    // Destaca link ativo
    document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPath) {
            link.classList.add('active');
            const parentDropdown = link.closest('.menu-dropdown');
            if (parentDropdown) {
                const submenu = parentDropdown.querySelector('.submenu');
                if (submenu) submenu.style.display = 'block';
            }
        }
    });

    // Alterna dropdowns
    document.querySelectorAll('.menu-dropdown > a').forEach(toggle => {
        toggle.addEventListener('click', e => {
            e.preventDefault();
            const submenu = toggle.nextElementSibling;
            if (submenu) {
                submenu.style.display = submenu.style.display === 'block' ? 'none' : 'block';
            }
        });
    });

    // Logout unificado
    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.addEventListener('click', e => {
            e.preventDefault();
            localStorage.removeItem('adminToken');
            localStorage.removeItem('adminAuthToken');
            localStorage.removeItem('token');
            window.location.href = '/admin/login.html';
        });
    }
}
