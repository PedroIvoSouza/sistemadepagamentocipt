// public/js/admin-sidebar.js
// Carrega o sidebar comum e aplica comportamento compartilhado

document.addEventListener('DOMContentLoaded', () => {
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
            .then(() => initSidebarBehaviour())
            .catch(err => console.error('Erro ao injetar sidebar:', err));
    } else {
        initSidebarBehaviour(); // Sidebar já está no HTML
    }
});

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
