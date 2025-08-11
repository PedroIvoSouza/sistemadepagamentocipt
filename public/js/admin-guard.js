// public/js/admin-guard.js
(function () {
  // Duas chaves para compatibilidade com páginas antigas
  const K1 = 'adminToken';
  const K2 = 'adminAuthToken';

  // Normaliza: se existir uma, replica para a outra
  let t = localStorage.getItem(K1) || localStorage.getItem(K2);
  if (!t) {
    // Sem token → volta pro login (somente em páginas do admin)
    if (location.pathname.startsWith('/admin/') && !location.pathname.endsWith('/admin/login.html')) {
      location.replace('/admin/login.html');
    }
    return;
  }
  // garante as duas chaves preenchidas
  localStorage.setItem(K1, t);
  localStorage.setItem(K2, t);

  // Helpers globais
  window.getAdminToken = () => localStorage.getItem(K1) || localStorage.getItem(K2) || '';
  window.logoutAdmin = () => {
    localStorage.removeItem(K1);
    localStorage.removeItem(K2);
    location.replace('/admin/login.html');
  };

  // Patch no fetch: injeta Authorization automaticamente em /api/...
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const isApiCall =
      url.startsWith('/api/') ||
      (url.includes('//' + location.host + '/') && url.includes('/api/'));

    const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
    if (isApiCall && !headers.has('Authorization')) {
      const token = window.getAdminToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    const resp = await originalFetch(input, { ...init, headers });

    // Se o token expirar/for inválido, limpa e volta pro login
    if (resp.status === 401 || resp.status === 403) {
      localStorage.removeItem(K1);
      localStorage.removeItem(K2);
      location.replace('/admin/login.html');
      throw new Error('Sessão expirada (401/403).');
    }
    return resp;
  };
})();
