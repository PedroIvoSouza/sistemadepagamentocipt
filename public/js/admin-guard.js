// public/js/admin-guard.js
(function () {
  const KEY = 'adminToken';

  // 1) Normaliza token (aceita adminAuthToken antigo)
  let token = localStorage.getItem(KEY) || localStorage.getItem('adminAuthToken');
  if (!token) {
    // sem token? manda pro login
    location.replace('/admin/login.html');
    return;
  }
  localStorage.setItem(KEY, token);
  localStorage.removeItem('adminAuthToken');

  // 2) Helpers globais
  window.getAdminToken = () => localStorage.getItem(KEY);
  window.logoutAdmin = () => { localStorage.removeItem(KEY); location.replace('/admin/login.html'); };

  // 3) Patch no fetch: injeta Authorization automaticamente p/ chamadas de API
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    try {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const isApiCall =
        url.startsWith('/api/') ||
        url.includes('//' + location.host + '/') && url.includes('/api/');

      // monta headers
      const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (isApiCall && !headers.has('Authorization')) {
        const t = window.getAdminToken();
        if (t) headers.set('Authorization', `Bearer ${t}`);
      }

      const resp = await originalFetch(input, { ...init, headers });

      if (resp.status === 401 || resp.status === 403) {
        // token inválido/expirado -> limpa e volta ao login
        localStorage.removeItem(KEY);
        location.replace('/admin/login.html');
        throw new Error('Sessão expirada (401/403).');
      }
      return resp;
    } catch (e) {
      // Em caso de erro de rede, deixa estourar para quem chamou
      throw e;
    }
  };
})();
