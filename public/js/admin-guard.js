// public/js/admin-guard.js
(function () {
  // Duas chaves para compat com páginas antigas
  const K1 = 'adminToken';
  const K2 = 'adminAuthToken';

  // Normaliza token (se existir uma, replica para a outra)
  let t = localStorage.getItem(K1) || localStorage.getItem(K2);
  if (!t) {
    // Sem token → volta pro login (apenas em páginas do admin, exceto a própria de login)
    if (location.pathname.startsWith('/admin/') && !location.pathname.endsWith('/admin/login.html')) {
      location.replace('/admin/login.html');
    }
    return; // não patcha fetch sem token
  }
  localStorage.setItem(K1, t);
  localStorage.setItem(K2, t);

  // Helpers globais
  window.getAdminToken = () => localStorage.getItem(K1) || localStorage.getItem(K2) || '';
  window.logoutAdmin = () => {
    localStorage.removeItem(K1);
    localStorage.removeItem(K2);
    location.replace('/admin/login.html');
  };

  // Patch no fetch: injeta Authorization automaticamente em chamadas /api/
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
    const isSameHostApi =
      urlStr.startsWith('/api/') ||
      (urlStr.includes('//' + location.host + '/') && urlStr.includes('/api/'));

    const headers = new Headers(
      (typeof init.headers !== 'undefined' && init.headers) ||
      (typeof input !== 'string' && input && input.headers) ||
      {}
    );

    if (isSameHostApi && !headers.has('Authorization')) {
      const token = window.getAdminToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    const resp = await originalFetch(input, { ...init, headers });

    // Se o token expirar/for inválido, limpa e volta pro login
    if ((resp.status === 401 || resp.status === 403) &&
        !location.pathname.endsWith('/admin/login.html')) {
      localStorage.removeItem(K1);
      localStorage.removeItem(K2);
      location.replace('/admin/login.html');
      throw new Error('Sessão expirada (401/403).');
    }

    return resp;
  };

  // Wrapper opcional padronizado
  window.apiFetch = async (path, options = {}) => {
    const token = window.getAdminToken();
    if (!token) {
      window.location.href = '/admin/login.html';
      throw new Error('Sessão expirada');
    }
    const headers = Object.assign(
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      options.headers || {}
    );
    return fetch(path, { ...options, headers });
  };
})();
