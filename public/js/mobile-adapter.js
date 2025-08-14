// ==============================
// Mobile Adapter (sem injeções duplicadas)
//  - define --vh (iOS)
//  - evita pull-to-refresh fora do topo
//  - topbar com sombra ao rolar
//  - reflow de tabelas (thead -> labels nos td)
//  - hamburger/fechamento fora da sidebar
// ==============================
(function () {
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isSmall = () => window.matchMedia('(max-width:768px)').matches;
  const isMobile = () => isMobileUA || isSmall();
  window.__isMobile = isMobile;

  // ---- 1) --vh para iOS ----
  function setVhUnit() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
  }

  // ---- 2) Topbar com sombra ao rolar ----
  function topbarShadow() {
    const tb = document.querySelector('.topbar');
    if (!tb) return;
    const y = (document.scrollingElement || document.documentElement).scrollTop || window.pageYOffset;
    tb.classList.toggle('scrolled', y > 4);
  }

  // ---- 3) Hamburger / Sidebar ----
  function ensureHamburger() {
    const topbar = document.querySelector('.topbar');
    const sidebar = document.querySelector('.sidebar');
    if (!topbar || !sidebar) return;
    if (document.getElementById('mobile-hamburger')) return;

    const btn = document.createElement('button');
    btn.id = 'mobile-hamburger';
    btn.className = 'mobile-hamburger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Abrir menu');
    btn.innerHTML = '<i class="bi bi-list"></i>';

    btn.addEventListener('click', () => sidebar.classList.toggle('open'));
    topbar.prepend(btn);

    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('mobile')) return;
      if (!sidebar.classList.contains('open')) return;
      if (!e.target.closest('.sidebar') && !e.target.closest('#mobile-hamburger')) {
        sidebar.classList.remove('open');
      }
    });
  }

  // ---- 4) Reflow de tabelas -> cards (agora pega QUALQUER <table>) ----
function reflowTable(tbl) {
  if (!tbl || tbl.hasAttribute('data-no-mobile-cards')) return;
  // precisa ter thead com th para extrair os rótulos
  const ths = tbl.querySelectorAll('thead th');
  if (!ths.length) return;
  if (tbl.__reflowApplied) return;

  const headers = [...ths].map(th => th.textContent.trim());
  tbl.__headers = headers;

  const applyRow = (tr) => {
    [...tr.children].forEach((td, i) => {
      const label = headers[i];
      if (!label) return;
      if (!td.querySelector('div.__label')) {
        const l = document.createElement('div');
        l.className = '__label';
        l.textContent = label;
        td.prepend(l);
      }
    });
  };

  tbl.querySelectorAll('tbody tr').forEach(applyRow);
  tbl.__reflowApplied = true;
  tbl.__applyRow = applyRow;
}

function reflowTables() {
  if (!document.body.classList.contains('mobile')) return;
  document.querySelectorAll('table').forEach(reflowTable);
}

function undoReflow() {
  document.querySelectorAll('table').forEach(tbl => {
    if (!tbl.__reflowApplied) return;
    tbl.__reflowApplied = false;
    tbl.querySelectorAll('tbody td .__label').forEach(n => n.remove());
  });
}

// Observer (debounced) para quando a tabela mudar por fetch/paginação
let tableObserver;
function observeTables() {
  if (tableObserver) return;
  const cb = () => {
    clearTimeout(observeTables.__to);
    observeTables.__to = setTimeout(reflowTables, 80);
  };
  tableObserver = new MutationObserver(cb);
  document.querySelectorAll('table tbody').forEach(tb => {
    tableObserver.observe(tb, { childList: true, subtree: true });
  });
}

// ---- Compat de login: aplica classes “compat” quando não existem ----
  function compatLoginBrandAndHero() {
  if (!isMobile()) return;

  // Tenta identificar páginas de login pela presença de um form com senha ou botão "Acessar"
  const isLogin = !!document.querySelector('form [type="password"], form button[type="submit"], form .btn-primary');

  if (!isLogin) return;

  // 1) Faixa de marcas (topo azul) — se existir uma faixa com múltiplas <img>, aplica classes
  const possibleStrips = [
    '.brand-strip', 'header .logos', '.header-brand', '.header .logos', '.topbar .logos'
  ];
  let strip = document.querySelector(possibleStrips.join(','));
  if (!strip) {
    // cria uma strip se houver um header azul com imagens
    const headerImgs = document.querySelectorAll('header img, .topbar img');
    if (headerImgs.length >= 2) {
      const header = document.querySelector('header') || document.querySelector('.topbar');
      if (header) {
        strip = document.createElement('div');
        strip.className = 'brand-strip';
        header.appendChild(strip);
        headerImgs.forEach(img => strip.appendChild(img)); // move as imagens para o strip
      }
    }
  } else {
    strip.classList.add('brand-strip'); // garante a classe
  }

  // 2) Hero/Logo central — reduz a logo “grande”
  const heroLogo = document.querySelector('.login-hero img, .hero img, .banner img, .portal-logo');
  if (heroLogo && !heroLogo.classList.contains('hero-logo')) {
    heroLogo.classList.add('hero-logo');
  }
}

// ---- Impede pinch-zoom para evitar layout quebrado ----
function disableZoom() {
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend', e => e.preventDefault(), { passive: false });
}


  // ---- 5) Pull-to-refresh só no topo ----
  function setupPullToRefresh() {
    const cont = document.querySelector('.content') || document.querySelector('main') || document.body;
    if (!cont || cont.__ptrApplied) return;
    cont.__ptrApplied = true;

    let startY = 0;
    let pulling = false;
    const THRESHOLD = 70;

    const canStart = () => {
      // apenas se estiver no topo do scroll
      const el = document.scrollingElement || document.documentElement;
      return (el.scrollTop || 0) <= 0;
    };

    cont.addEventListener('touchstart', (e) => {
      if (!isMobile()) return;
      if (!canStart()) { pulling = false; return; }
      if (e.target.closest('input,textarea,select')) { pulling = false; return; }
      startY = e.touches[0].clientY;
      pulling = true;
    }, { passive: true });

    cont.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) {
        // evita bounce do navegador
        e.preventDefault();
      }
    }, { passive: false });

    cont.addEventListener('touchend', (e) => {
      if (!pulling) return;
      const dy = (e.changedTouches?.[0]?.clientY || 0) - startY;
      pulling = false;
      if (dy >= THRESHOLD && canStart()) {
        // feedback rápido (opcional)
        const ov = document.createElement('div');
        ov.className = 'ui-loading show';
        ov.innerHTML = '<div class="ui-spinner"></div>';
        document.body.appendChild(ov);
        setTimeout(() => location.reload(), 80);
      }
    });
  }

  // ---- 6) Aplicar/reativar conforme viewport ----
  function apply() {
    // define --vh
    setVhUnit();

  if (isMobile()) {
    document.body.classList.add('mobile');
    ensureHamburger();
    compatLoginBrandAndHero();
    disableZoom();
    reflowTables();
    observeTables();
    setupPullToRefresh();
  } else {
    document.body.classList.remove('mobile');
      undoReflow();
      document.querySelector('.sidebar')?.classList.remove('open');
    }

    topbarShadow();
  }

  function apply() {
  setVhUnit();

  if (isMobile()) {
    document.body.classList.add('mobile');
    ensureHamburger();
    compatLoginBrandAndHero();   // <<< ADICIONADA AQUI
    disableZoom();
    reflowTables();
    observeTables();
    setupPullToRefresh();
  } else {
    document.body.classList.remove('mobile');
    undoReflow();
    document.querySelector('.sidebar')?.classList.remove('open');
  }

  topbarShadow();
}


  // Listeners globais (throttled/debounced)
  document.addEventListener('DOMContentLoaded', apply);

  let resizeTO;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTO);
    resizeTO = setTimeout(() => { setVhUnit(); apply(); }, 120);
  });

  window.addEventListener('scroll', () => {
    // só atualiza sombra do header (barato)
    topbarShadow();
  }, { passive: true });

  // iOS zoom fix em inputs (sem “piscar” a UI)
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input,select,textarea')) {
      document.documentElement.style.fontSize = '105%';
    }
  });
  document.addEventListener('focusout', () => {
    document.documentElement.style.fontSize = '';
  });
})();