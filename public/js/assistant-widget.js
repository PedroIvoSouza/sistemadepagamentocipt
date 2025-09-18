(function () {
  if (window.CIPTAssistantWidgetLoaded) return;
  window.CIPTAssistantWidgetLoaded = true;

  const STYLE_HREF = '/css/assistant-widget.css';
  const SELECTORS = {
    launcher: 'assistant-launcher',
    panel: 'assistant-panel',
    messages: 'assistant-messages',
    textarea: 'assistant-textarea',
    sendButton: 'assistant-send',
    suggestions: 'assistant-suggestions',
    status: 'assistant-status',
  };

  const state = {
    initialized: false,
    open: false,
    audience: 'public',
    token: null,
    endpoints: {
      bootstrap: '/api/assistant/public/bootstrap',
      message: '/api/assistant/public/message',
    },
    suggestions: [],
    history: [],
    context: {},
    statusNote: '',
    messages: [],
  };

  function injectStylesheet() {
    if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
  }

  function getToken(keys) {
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value) return value;
    }
    return null;
  }

  function resolveContext() {
    const path = window.location.pathname || '';
    const adminToken = getToken(['adminAuthToken', 'adminToken', 'token']);
    const permissionarioToken = getToken(['authToken']);
    const eventosToken = getToken(['token_evento']);

    if (path.startsWith('/admin/')) {
      if (adminToken) {
        return {
          audience: 'admin',
          token: adminToken,
          bootstrap: '/api/assistant/admin/bootstrap',
          message: '/api/assistant/admin/message',
        };
      }
      return {
        audience: 'admin',
        token: null,
        bootstrap: '/api/assistant/public/bootstrap?audience=admin',
        message: '/api/assistant/public/message',
      };
    }

    if (path.startsWith('/eventos/')) {
      if (eventosToken) {
        return {
          audience: 'cliente_evento',
          token: eventosToken,
          bootstrap: '/api/assistant/eventos/bootstrap',
          message: '/api/assistant/eventos/message',
        };
      }
      return {
        audience: 'cliente_evento',
        token: null,
        bootstrap: '/api/assistant/public/bootstrap?audience=cliente_evento',
        message: '/api/assistant/public/message',
      };
    }

    if (permissionarioToken) {
      return {
        audience: 'permissionario',
        token: permissionarioToken,
        bootstrap: '/api/assistant/portal/bootstrap',
        message: '/api/assistant/portal/message',
      };
    }

    return {
      audience: 'permissionario',
      token: null,
      bootstrap: '/api/assistant/public/bootstrap?audience=permissionario',
      message: '/api/assistant/public/message',
    };
  }

  function createLauncher() {
    const launcher = document.createElement('button');
    launcher.className = SELECTORS.launcher;
    launcher.setAttribute('type', 'button');
    launcher.setAttribute('aria-label', 'Abrir chat de ajuda');
    launcher.innerHTML = '<span>?</span>';
    launcher.addEventListener('click', togglePanel);
    document.body.appendChild(launcher);
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.className = SELECTORS.panel;
    panel.innerHTML = `
      <div class="assistant-header">
        <h3 id="assistant-title">Assistente do CIPT</h3>
        <button type="button" id="assistant-close" aria-label="Fechar">×</button>
      </div>
      <div class="assistant-body">
        <div class="assistant-messages" id="${SELECTORS.messages}"></div>
        <div class="assistant-suggestions" id="${SELECTORS.suggestions}"></div>
        <div class="assistant-input">
          <form id="assistant-form">
            <textarea id="${SELECTORS.textarea}" placeholder="Escreva sua dúvida" rows="2"></textarea>
            <button type="submit" id="${SELECTORS.sendButton}">Enviar</button>
          </form>
        </div>
        <div class="assistant-status-bar" id="${SELECTORS.status}"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#assistant-close').addEventListener('click', togglePanel);
    const form = panel.querySelector('#assistant-form');
    form.addEventListener('submit', onSubmitMessage);
  }

  function togglePanel() {
    const panel = document.querySelector(`.${SELECTORS.panel}`);
    if (!panel) return;
    state.open = !state.open;
    panel.classList.toggle('open', state.open);
    if (state.open && !state.initialized) {
      bootstrapAssistant();
    }
    if (state.open) {
      const textarea = panel.querySelector(`#${SELECTORS.textarea}`);
      setTimeout(() => textarea?.focus(), 150);
    }
  }

  function renderMessages() {
    const container = document.getElementById(SELECTORS.messages);
    if (!container) return;
    container.innerHTML = '';
    state.messages?.forEach((msg) => {
      const el = document.createElement('div');
      el.className = `assistant-message ${msg.role === 'user' ? 'user' : 'bot'} ${msg.type || ''}`.trim();
      el.innerHTML = msg.text;
      container.appendChild(el);
    });
    container.scrollTop = container.scrollHeight;
  }

  function addMessage(message) {
    state.messages = state.messages || [];
    state.messages.push(message);
    renderMessages();
  }

  function renderSuggestions() {
    const wrap = document.getElementById(SELECTORS.suggestions);
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!Array.isArray(state.suggestions) || !state.suggestions.length) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'flex';
    state.suggestions.forEach((suggestion) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = suggestion.question || suggestion.title;
      btn.addEventListener('click', () => {
        sendUserMessage(suggestion.question || suggestion.title);
      });
      wrap.appendChild(btn);
    });
  }

  function updateStatus(text) {
    const bar = document.getElementById(SELECTORS.status);
    if (bar) {
      bar.textContent = text || '';
    }
  }

  async function bootstrapAssistant() {
    state.initialized = true;
    addMessage({ role: 'assistant', text: 'Carregando o assistente, só um instante…', type: 'notice' });

    const headers = { 'Content-Type': 'application/json' };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    try {
      const res = await fetch(state.endpoints.bootstrap, { headers });
      if (!res.ok) throw new Error(`Falha ao inicializar (HTTP ${res.status})`);
      const data = await res.json();
      state.context = data.context || {};
      state.suggestions = data.suggestions || [];

      let status = 'Assistente pronto para ajudar.';
      if (data.capabilities) {
        if (!data.capabilities.openAiConfigured) {
          status = 'Assistente em modo básico (IA não conectada).';
        } else if (!data.capabilities.vectorStoreReady) {
          status = 'Assistente em modo resumido (indexação do código pendente).';
        }
      }
      state.statusNote = status;
      updateStatus(status);

      const greeting = buildGreeting(data.context, data.audience);
      state.messages = [];
      addMessage({ role: 'assistant', text: greeting });
      renderSuggestions();
    } catch (err) {
      state.statusNote = 'Não consegui carregar os dados do assistente.';
      updateStatus(state.statusNote);
      state.messages = [];
      addMessage({
        role: 'assistant',
        text: 'Não consegui carregar todas as informações agora, mas você pode mandar sua pergunta que eu tento ajudar mesmo assim.',
      });
    }
  }

  function buildGreeting(context, audience) {
    const name = context?.profile?.nome || context?.profile?.nome_empresa || '';
    const firstName = name ? name.split(' ')[0] : '';
    const saudacao = firstName ? `Olá, ${firstName}!` : 'Olá!';
    let foco = 'Sou o assistente virtual do CIPT. Conte o que você precisa que eu explico passo a passo.';
    if (audience === 'admin') {
      foco = 'Sou o assistente virtual do CIPT para administradores. Pergunte sobre painéis, DARs, eventos ou advertências que eu te guio pelo sistema.';
    } else if (audience === 'cliente_evento') {
      foco = 'Sou o assistente virtual do CIPT para clientes de eventos. Posso te ajudar com termos, DARs e remarcações.';
    }
    return `${saudacao} ${foco}`;
  }

  function sanitizeHistory() {
    return state.history.slice(-6);
  }

  function onSubmitMessage(event) {
    event.preventDefault();
    const textarea = document.getElementById(SELECTORS.textarea);
    if (!textarea) return;
    const value = textarea.value.trim();
    if (!value) return;
    textarea.value = '';
    sendUserMessage(value);
  }

  async function sendUserMessage(text) {
    addMessage({ role: 'user', text });
    state.history.push({ role: 'user', content: text });
    renderSuggestions();

    const headers = { 'Content-Type': 'application/json' };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    const payload = {
      message: text,
      history: sanitizeHistory(),
    };
    if (!state.token) {
      payload.audience = state.audience;
    }

    const sendButton = document.getElementById(SELECTORS.sendButton);
    if (sendButton) sendButton.disabled = true;

    try {
      const res = await fetch(state.endpoints.message, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Falha ao consultar o assistente (HTTP ${res.status})`);
      }

      const data = await res.json();

      if (data.intermediateNotice) {
        addMessage({ role: 'assistant', text: data.intermediateNotice, type: 'notice' });
      }

      if (data.reply) {
        addMessage({ role: 'assistant', text: data.reply });
        state.history.push({ role: 'assistant', content: data.reply });
      } else {
        addMessage({
          role: 'assistant',
          text: 'Recebi a resposta em branco. Tente perguntar novamente ou fale com o suporte.',
        });
      }

      if (data.context) {
        state.context = data.context;
      }
    } catch (err) {
      addMessage({
        role: 'assistant',
        text: 'Tive um problema técnico para consultar a plataforma agora. Se a dúvida for urgente, escreva para supcti@secti.al.gov.br.',
        type: 'notice',
      });
    } finally {
      if (sendButton) sendButton.disabled = false;
      updateStatus(state.statusNote);
    }
  }

  function init() {
    injectStylesheet();
    const resolved = resolveContext();
    state.audience = resolved.audience;
    state.token = resolved.token;
    state.endpoints = {
      bootstrap: resolved.bootstrap,
      message: resolved.message,
    };
    createLauncher();
    createPanel();
  }

  const { readyState } = document;
  if (readyState === 'interactive' || readyState === 'complete') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
