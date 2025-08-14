// /public/js/mobile-adapter.js
(function(){
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isSmall = ()=> window.matchMedia('(max-width:768px)').matches;
  const isMobile = ()=> isMobileUA || isSmall();
  window.__isMobile = isMobile;

  // injeta CSS/JS base
  function inject(tag, attrs){ const el=document.createElement(tag); Object.assign(el, attrs); document.head.appendChild(el); return el; }
  function ensureAssets(){
    if (!document.querySelector('link[data-app-shell]')){
      const l = inject('link',{ rel:'stylesheet', href:'/css/app-shell.css' }); l.dataset.appShell='1';
    }
    if (!document.querySelector('script[data-ui-kit]')){
      const s = inject('script',{ src:'/js/ui-kit.js', defer:true }); s.dataset.uiKit='1';
    }
    if (!document.querySelector('meta[name="theme-color"]')){
      const m = document.createElement('meta'); m.name='theme-color'; m.content='#0056a0'; document.head.appendChild(m);
    }
  }

  // Hamburger / sidebar
  function ensureHamburger(){
    const topbar=document.querySelector('.topbar');
    const sidebar=document.querySelector('.sidebar');
    if (!topbar || !sidebar) return;
    if (document.getElementById('mobile-hamburger')) return;
    const btn=document.createElement('button'); btn.id='mobile-hamburger'; btn.className='mobile-hamburger'; btn.innerHTML='<i class="bi bi-list"></i>';
    btn.addEventListener('click',()=> sidebar.classList.toggle('open'));
    topbar.prepend(btn);
    document.addEventListener('click',(e)=>{
      if (!document.body.classList.contains('mobile')) return;
      if (!sidebar.classList.contains('open')) return;
      if (!e.target.closest('.sidebar') && !e.target.closest('#mobile-hamburger')) sidebar.classList.remove('open');
    });
  }

  // Reflow de tabelas -> cartões
  function reflowTable(tbl){
    if (tbl.__reflowApplied) return;
    const headers=[...tbl.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    tbl.__reflowApplied=true; tbl.__headers=headers;
    [...tbl.querySelectorAll('tbody tr')].forEach(tr=>{
      [...tr.children].forEach((td,i)=>{
        const label=headers[i]; if (!label) return;
        if (!td.querySelector('.__label')){ const l=document.createElement('div'); l.className='__label'; l.textContent=label; td.prepend(l); }
      });
    });
  }
  function reflowTables(){ document.querySelectorAll('table.table').forEach(reflowTable); }
  function undoReflow(){
    document.querySelectorAll('table.table').forEach(tbl=>{
      if (!tbl.__reflowApplied) return;
      tbl.__reflowApplied=false;
      tbl.querySelectorAll('tbody td .__label').forEach(n=>n.remove());
    });
  }
  // Observa mudanças (por fetch) no tbody e reaplica
  function observeTables(){
    const obs = new MutationObserver(()=>{ if (document.body.classList.contains('mobile')) reflowTables(); });
    document.querySelectorAll('table.table tbody').forEach(tb=>obs.observe(tb,{childList:true,subtree:true}));
  }

  // Pull-to-refresh na área principal
  function setupPTR(){
    const cont = document.querySelector('.content') || document.querySelector('main') || document.body;
    if (!cont || cont.__ptrApplied) return; cont.__ptrApplied=true;
    const fn = ()=>location.reload();
    const tryAttach = ()=> { if (window.AppUI?.attachPullToRefresh) AppUI.attachPullToRefresh(cont, fn); else setTimeout(tryAttach, 50); };
    tryAttach();
  }

  // PWA (manifest + SW)
  function registerPWA(){
    if (!('serviceWorker' in navigator)) return;
    if (!document.querySelector('link[rel="manifest"]')){
      const l=document.createElement('link'); l.rel='manifest'; l.href='/manifest.webmanifest'; document.head.appendChild(l);
    }
    navigator.serviceWorker.getRegistration().then(reg=>{
      if (!reg) navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
    });
    // Prompt amigável (uma vez)
    window.addEventListener('beforeinstallprompt', (e)=>{
      e.preventDefault();
      if (localStorage.getItem('pwa_prompt_done')) return;
      const show = ()=> AppUI?.sheet?.show(`
        <div style="padding:1rem">
          <h5>Instalar na tela inicial?</h5>
          <p>Use como um app, com acesso rápido e offline leve.</p>
          <div class="d-grid gap-2">
            <button class="btn btn-primary" id="pwaInstall">Instalar</button>
            <button class="btn btn-outline-secondary" onclick="AppUI.sheet.hide()">Agora não</button>
          </div>
        </div>
      `);
      const tryShow = ()=> { if (window.AppUI?.sheet) show(); else setTimeout(tryShow, 80); };
      tryShow();
      document.addEventListener('click', (ev)=>{
        if (ev.target?.id==='pwaInstall'){
          AppUI.sheet.hide(); e.prompt?.(); localStorage.setItem('pwa_prompt_done','1');
        }
      }, {once:true});
    });
  }

  function apply(){
    ensureAssets();
    if (isMobile()){ document.body.classList.add('mobile'); reflowTables(); ensureHamburger(); setupPTR(); observeTables(); }
    else { document.body.classList.remove('mobile'); undoReflow(); document.querySelector('.sidebar')?.classList.remove('open'); }
    registerPWA();
  }

  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('resize', ()=>{ clearTimeout(window.__mobTO); window.__mobTO=setTimeout(apply,150); });

  // iOS zoom fix em inputs
  document.addEventListener('focusin', (e)=>{ if (e.target.matches('input,select,textarea')) document.documentElement.style.fontSize='105%'; });
  document.addEventListener('focusout', ()=>{ document.documentElement.style.fontSize=''; });
})();
