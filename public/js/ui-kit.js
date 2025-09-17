// /public/js/ui-kit.js
(function () {
  // -------- Toasts
  const wrapId = 'ui-toast-wrap';
  function toast(msg, type='') {
    let wrap = document.getElementById(wrapId);
    if (!wrap){ wrap = document.createElement('div'); wrap.id = wrapId; wrap.className = 'ui-toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'ui-toast ' + (type||'');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; setTimeout(()=>el.remove(),200); }, 3200);
  }

  // -------- Loading overlay
  let loadingEl;
  function ensureLoading(){
    if (loadingEl) return;
    loadingEl = document.createElement('div');
    loadingEl.className = 'ui-loading';
    loadingEl.innerHTML = `<div><div class="ui-spinner"></div></div>`;
    document.body.appendChild(loadingEl);
  }
  const loading = { show(){ ensureLoading(); loadingEl.classList.add('show'); }, hide(){ loadingEl?.classList.remove('show'); } };

  // -------- Bottom sheet
  let sheetEl;
  function ensureSheet(){
    if (sheetEl) return;
    sheetEl = document.createElement('div');
    sheetEl.className = 'ui-sheet'; sheetEl.innerHTML = `<div class="handle"></div><div class="inner"></div>`;
    document.body.appendChild(sheetEl);
    sheetEl.addEventListener('click', (e)=>{ if (e.target===sheetEl) sheet.hide(); });
  }
  const sheet = { show(html){ ensureSheet(); sheetEl.querySelector('.inner').innerHTML = html; sheetEl.classList.add('show'); }, hide(){ sheetEl?.classList.remove('show'); } };

  // -------- Pull-to-refresh
  function attachPullToRefresh(container, onRefresh){
    if (!container) return;
    let y0=0, pulling=false;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;left:0;right:0;top:0;height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#666;transition:height .2s;background:#eef3f7';
    bar.innerHTML = '<small>Puxe para atualizar…</small>';
    container.style.position='relative';
    container.prepend(bar);

    container.addEventListener('touchstart',(e)=>{ if(container.scrollTop<=0){ y0=e.touches[0].clientY; pulling=true; }});
    container.addEventListener('touchmove',(e)=>{
      if (!pulling) return;
      const dy = e.touches[0].clientY - y0;
      if (dy>0){ bar.style.height = Math.min(70, dy)+'px'; }
    });
    function end(){
      if (!pulling) return;
      pulling=false;
      if (parseInt(bar.style.height,10) >= 60){
        bar.innerHTML='<small>Atualizando…</small>';
        Promise.resolve(onRefresh?.()).finally(()=>{ bar.style.height='0px'; bar.innerHTML='<small>Puxe para atualizar…</small>'; });
      } else { bar.style.height='0px'; }
    }
    container.addEventListener('touchend', end);
    container.addEventListener('touchcancel', end);
  }

  // -------- Banner de rede
  function netBanner(){
    const el = document.createElement('div');
    el.className='net-banner'; el.textContent='Sem conexão com a internet';
    document.body.appendChild(el);
    function update(){ if (navigator.onLine){ el.classList.remove('show'); } else { el.classList.add('show'); } }
    window.addEventListener('online', update); window.addEventListener('offline', update); update();
  }

  // -------- Helper p/ tarefas longas
  async function withLongTask(promiseOrFn, {label='Processando…', timeoutMs=120000} = {}){
    loading.show();
    const msgId = setTimeout(()=>toast('Isso pode levar até 2 minutos…', 'warn'), 3000);
    try{
      const p = (typeof promiseOrFn === 'function') ? promiseOrFn() : promiseOrFn;
      // pequeno “safety” a mais que o timeout do back
      const timer = new Promise((_,rej)=>setTimeout(()=>rej(new Error('Tempo esgotado. Tente novamente.')), timeoutMs+5000));
      const result = await Promise.race([p, timer]);
      toast('Concluído!', 'success');
      return result;
    } finally {
      clearTimeout(msgId); loading.hide();
    }
  }

  // -------- (Opcional) Auto-loader para fetch POST /emitir e /enviar-notificacao
  (function hookFetch(){
    const ENABLE = true;  // se quiser desligar globalmente, mude para false
    if (!ENABLE || !window.fetch) return;
    const orig = window.fetch;
    window.fetch = async function(url, opts={}){
      const method = (opts.method || 'GET').toUpperCase();
      const u = String(url||'');
      const isLong = method!=='GET' && (u.includes('/emitir') || u.includes('/enviar-notificacao'));
      if (!isLong) return orig.apply(this, arguments);
      return withLongTask(()=>orig.apply(this, arguments), { timeoutMs: 120000 });
    };
  })();

  // -------- Prefetch leve de navegação (mobile)
  (function prefetchNav(){
    if (!('requestIdleCallback' in window)) return;
    const links = new Set();
    document.addEventListener('mouseover', e=>{
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href'); if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
      links.add(href);
      requestIdleCallback(()=>{ fetch(href, {method:'GET', mode:'no-cors'}).catch(()=>{}); links.delete(href); });
    }, {passive:true});
  })();

  // -------- Toggle para campos de senha
  function setupPasswordToggle(inputId, buttonId){
    const toggleButton = document.getElementById(buttonId);
    const passwordInput = document.getElementById(inputId);
    if (!toggleButton || !passwordInput) return;
    const icon = toggleButton.querySelector('i');
    toggleButton.addEventListener('click', () => {
      const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
      passwordInput.setAttribute('type', type);
      icon.classList.toggle('bi-eye-fill');
      icon.classList.toggle('bi-eye-slash-fill');
    });
  }

  // Expor a API
  window.AppUI = { toast, loading, sheet, attachPullToRefresh, withLongTask, setupPasswordToggle };
  window.setupPasswordToggle = setupPasswordToggle;
  document.addEventListener('DOMContentLoaded', netBanner);

  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('script[data-assistant-widget]')) return;
    const script = document.createElement('script');
    script.src = '/js/assistant-widget.js';
    script.defer = true;
    script.dataset.assistantWidget = 'true';
    document.body.appendChild(script);
  });
})();
