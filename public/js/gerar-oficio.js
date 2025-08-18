// public/js/gerar-oficio.js

window.gerarOficio = async function(permissionarioId) {
  const button = document.querySelector(`button.gerar-oficio-btn[data-id="${permissionarioId}"]`);
  const originalHtml = button ? button.innerHTML : '';
  try {
    if (button) {
      button.disabled = true;
      button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
    }

    const response = await fetch(`/api/admin/oficios/${permissionarioId}`, {
      method: 'POST'
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Erro ${response.status}`);
    }

    // Download do PDF
    const pdfResponse = await fetch(data.pdfUrl);
    const blob = await pdfResponse.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.pdfUrl.split('/').pop() || 'oficio.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    alert(`Token de autenticação: ${data.token}`);
  } catch (err) {
    alert(`Erro ao gerar ofício: ${err.message}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = originalHtml || 'Gerar Ofício';
    }
  }
};
