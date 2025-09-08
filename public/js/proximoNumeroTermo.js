async function fillNextNumeroTermo(mask, year) {
  try {
    const query = year ? `?ano=${year}` : '';
    const res = await fetch(`/api/admin/termos/proximo-numero${query}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Falha ao obter número');
    const data = await res.json();
    const valor = data.numeroTermo || '';
    if (mask) mask.value = valor;
    return valor;
  } catch (err) {
    console.error('Erro ao buscar próximo número do termo:', err);
    if (mask) mask.value = '';
    return '';
  }
}

if (typeof module !== 'undefined') module.exports = { fillNextNumeroTermo };
if (typeof window !== 'undefined') window.fillNextNumeroTermo = fillNextNumeroTermo;
