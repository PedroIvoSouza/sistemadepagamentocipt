// public/js/admin-relatorios.js
window.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnRelatorioDevedores');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/admin/relatorios/devedores');
      if (!resp.ok) throw new Error('Falha ao gerar relatório');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error(err);
      alert('Erro ao gerar relatório de devedores.');
    }
  });
});
