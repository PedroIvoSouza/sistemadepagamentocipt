(() => {
  // Evita executar duas vezes
  if (window.__CIPT_MOBILE_TWEAKS__) return;
  window.__CIPT_MOBILE_TWEAKS__ = true;

  // Detecta mobile/tablet
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  document.documentElement.classList.toggle('is-mobile', isMobile);

  // Troca 100vh por dvh em elementos “altos” (evita tremedeira ao rolar)
  const fixVh = () => {
    const dvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--vvh', `${dvh}px`);
    // Ex.: use .min-100vh e/ou aplique var(--vvh) manualmente quando necessário.
  };
  fixVh();
  window.addEventListener('resize', fixVh, { passive: true });
  window.addEventListener('orientationchange', fixVh, { passive: true });

  // Suaviza rolagem
  document.documentElement.style.scrollBehavior = 'smooth';

  // Desativa “pull to refresh” em Android Chrome quando possível
  document.body.style.overscrollBehaviorY = 'contain';

  // Aumenta área de toque dos filtros/selects
  const enlargeTapTargets = () => {
    document.querySelectorAll('button, .btn, select, .form-select, input[type="submit"]').forEach(el => {
      const h = parseFloat(getComputedStyle(el).height);
      if (h < 44) el.style.minHeight = '44px';
      el.style.borderRadius = '12px';
    });
  };
  enlargeTapTargets();

  // Autoformata cards de DAR existentes (sem mexer no HTML gerado)
  const enhanceDarCards = () => {
    document.querySelectorAll('table .enviar-notificacao-btn, .btn-emitir, .btn-preview').forEach(btn => {
      btn.classList.add('btn'); // garante classe de botão
    });
    // Se houver contêiner de lista, aplica classe “list-fluid”
    const tb = document.getElementById('dars-table-body');
    if (tb) tb.classList.add('list-fluid');
  };
  enhanceDarCards();

  // Evita recarregar dados ao rolar (caso alguma página amarrou scroll->fetch)
  const stopScrollFetch = (eName='scroll') => {
    // Procura listeners declarados diretamente (pouco comum), mas se houver, avisa no console.
    // A ideia aqui é apenas documentar — sua página atual não faz fetch no scroll.
    // Se algum listener custom existir, troque por "IntersectionObserver" com debounce.
  };
})();