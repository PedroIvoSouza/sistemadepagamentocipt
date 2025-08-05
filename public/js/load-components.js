// public/js/load-components.js

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    // Se não houver token e não estivermos na página de login, redireciona.
    if (!token && !window.location.pathname.includes('/login.html')) {
        window.location.href = '/login.html';
        return;
    }

    // Função para carregar HTML de um arquivo em um elemento
    const loadComponent = (url, elementId) => {
        return fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Não foi possível carregar ${url}`);
                }
                return response.text();
            })
            .then(data => {
                const element = document.getElementById(elementId);
                if (element) {
                    element.innerHTML = data;
                }
            });
    };

    // Destaca o link ativo no menu lateral com base na URL atual
    const setActiveSidebarLink = () => {
        const path = window.location.pathname;
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;

        const links = sidebar.querySelectorAll('.sidebar-link');

        links.forEach(link => {
            const li = link.closest('.sidebar-item');
            if (li) {
                // Remove a classe 'active' de todos para começar do zero
                li.classList.remove('active');
                // Se o href do link corresponde à página atual, adiciona a classe 'active'
                if (link.getAttribute('href') === path) {
                    li.classList.add('active');
                }
            }
        });
    };

    // Carrega todos os componentes em paralelo
    Promise.all([
        loadComponent('/admin/admin-sidebar.html', 'sidebar'),
        loadComponent('/admin/admin-topbar.html', 'topbar'),
        loadComponent('/admin/admin-footer.html', 'footer')
    ]).then(() => {
        // Depois que todos os componentes forem carregados
        feather.replace(); // Renderiza os ícones Feather
        setActiveSidebarLink(); // Destaca o link ativo no menu

        // Adiciona funcionalidade de logout ao botão na topbar
        const logoutButton = document.getElementById('logoutButton');
        if (logoutButton) {
            logoutButton.addEventListener('click', (e) => {
                e.preventDefault();
                localStorage.removeItem('token');
                window.location.href = '/login.html';
            });
        }
    }).catch(error => console.error("Erro ao carregar componentes:", error));
});