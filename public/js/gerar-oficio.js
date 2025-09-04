// /js/gerar-oficio.js
(function(){
  async function baixarBlobComoArquivo(blob, filenameFallback) {
    // tenta extrair nome pelo content-disposition, senão usa fallback
    const a = document.createElement('a');
    const url = window.URL.createObjectURL(blob);
    a.href = url;
    a.download = filenameFallback || 'oficio.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  function filenameFromDisposition(disposition, fallback) {
    if (!disposition) return fallback;
    const m = /filename\*?=(?:UTF-8''|")?([^\";]+)\"?/.exec(disposition);
    if (!m) return fallback;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }

  async function gerarOficio(permissionarioId) {
    const token = localStorage.getItem('adminAuthToken');
    if (!token) {
      alert('Sessão expirada. Faça login novamente.');
      window.location.href = '/admin/login.html';
      return;
    }

    // feedback visual no botão clicado (se existir)
    const btn = document.querySelector(`.gerar-oficio-btn[data-id="${permissionarioId}"]`);
    const oldHTML = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Gerando...'; }

    try {
      const res = await fetch(`/api/admin/oficios/${permissionarioId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        // use credentials: 'include' só se você TAMBÉM usa cookies de sessão:
        // credentials: 'include',
      });

      // se não veio 2xx, tenta ler mensagem de erro
      if (!res.ok) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          throw new Error(data.error || `Erro ${res.status} ao gerar ofício.`);
        } catch {
          throw new Error(text || `Erro ${res.status} ao gerar ofício.`);
        }
      }

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/pdf')) {
        // pode ter vindo HTML 200 (login/proxy)
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          throw new Error(data.error || 'Resposta inesperada (não-PDF).');
        } catch {
          throw new Error(text || 'Resposta inesperada (não-PDF).');
        }
      }

      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition');
      const filename = filenameFromDisposition(disposition, `oficio_${permissionarioId}.pdf`);
      await baixarBlobComoArquivo(blob, filename);
    } catch (err) {
      console.error('gerarOficio erro:', err);
      alert(err.message || 'Erro ao gerar ofício.');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = oldHTML; }
    }
  }

  // expõe globalmente para o handler inline
  window.gerarOficio = gerarOficio;
})();
