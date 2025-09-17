const { matchKnowledgeBase } = require('./knowledgeBaseMatcher');
const knowledgeBase = require('./knowledgeBase');
const { applyTemplate } = require('./template');
const {
  getPermissionarioContext,
  getAdminContext,
  getClienteEventoContext,
} = require('./contextFetchers');
const { ensureVectorStore, searchSimilarChunks, hasVectorStoreLoaded } = require('./vectorStore');
const { getClient, isConfigured } = require('./openaiClient');
const {
  openAiModel,
  knowledgeBaseNoticeDelayMs,
  fallbackEmail,
} = require('./assistantConfig');

function createAnonymousContext(audience) {
  return {
    type: audience || 'public',
    anonymous: true,
  };
}

async function fetchContext(audience, userId) {
  if (!userId) {
    return createAnonymousContext(audience);
  }

  switch (audience) {
    case 'permissionario':
      return getPermissionarioContext(userId);
    case 'admin':
      return getAdminContext(userId);
    case 'cliente_evento':
      return getClienteEventoContext(userId);
    default:
      return createAnonymousContext(audience);
  }
}

function buildFlowAnswer(flow, context) {
  const title = applyTemplate(flow.title, context);
  const summary = applyTemplate(flow.summary || '', context);

  const lines = [];
  if (title) {
    lines.push(`**${title}**`);
  }
  if (summary) {
    lines.push('');
    lines.push(summary);
  }
  if (Array.isArray(flow.steps) && flow.steps.length) {
    lines.push('');
    flow.steps.forEach((step, index) => {
      const stepTitle = applyTemplate(step.title || '', context);
      const detail = applyTemplate(step.detail || '', context);
      const label = stepTitle ? `Passo ${index + 1} – ${stepTitle}` : `Passo ${index + 1}`;
      lines.push(`**${label}:** ${detail}`.trim());
    });
  }
  if (flow.followUp) {
    lines.push('');
    lines.push(`ℹ️ ${applyTemplate(flow.followUp, context)}`.trim());
  }
  return lines.join('\n');
}

function extractSuggestions(audience, max = 5) {
  const flows = knowledgeBase
    .filter((flow) => {
      const audiences = Array.isArray(flow.audiences) ? flow.audiences : [];
      return audiences.includes(audience) || (audience !== 'public' && audiences.includes('public'));
    })
    .slice(0, max);

  return flows.map((flow) => ({
    id: flow.id,
    question: `Como ${flow.title.toLowerCase()}?`,
    title: flow.title,
    summary: flow.summary,
  }));
}

function pickAudience(rawAudience = 'public') {
  const map = {
    portal: 'permissionario',
    permissionario: 'permissionario',
    admin: 'admin',
    eventos: 'cliente_evento',
    cliente_evento: 'cliente_evento',
    public: 'public',
  };
  return map[rawAudience] || 'public';
}

function buildFallbackMessage() {
  return `Tentei tudo o que estava ao meu alcance aqui dentro da plataforma e não consegui concluir a ajuda. Escreva para ${fallbackEmail} e a equipe do CIPT responde em até 24h úteis.`;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && typeof item === 'object' && typeof item.role === 'string' && typeof item.content === 'string')
    .slice(-6);
}

async function answerWithKnowledgeBase({ audience, message, context }) {
  const match = matchKnowledgeBase({ audience, message });
  if (!match) {
    return null;
  }

  const { flow } = match;
  const reply = buildFlowAnswer(flow, context);
  return {
    origin: 'knowledge-base',
    flowId: flow.id,
    reply,
    title: flow.title,
    steps: flow.steps || [],
    followUp: flow.followUp ? applyTemplate(flow.followUp, context) : null,
  };
}

function buildRepoPrompt({ audience, context, codeSnippets, message, history }) {
  const contextSummary = {
    audience,
    anonymous: context?.anonymous || false,
    profile: context?.profile || null,
    stats: context?.stats || null,
  };

  const snippetsText = codeSnippets
    .map((chunk, idx) => {
      const header = `Trecho ${idx + 1}: ${chunk.file || 'desconhecido'}:${chunk.startLine || '?'}-${chunk.endLine || '?'}`;
      return `${header}\n${chunk.content}`;
    })
    .join('\n\n');

  const instructions = `Você é o agente virtual do Sistema de Pagamentos do CIPT. Responda sempre em português do Brasil usando passos numerados quando estiver guiando o usuário. Seja acolhedor, objetivo e evite jargões técnicos. Quando possível, referencie o nome exato dos botões, abas e mensagens exibidas na tela.`;

  const messages = [
    { role: 'system', content: instructions },
    {
      role: 'assistant',
      content: `Contexto do usuário (JSON): ${JSON.stringify(contextSummary)}`,
    },
  ];

  if (snippetsText) {
    messages.push({
      role: 'assistant',
      content: `Trechos relevantes do código e da documentação:\n\n${snippetsText}`,
    });
  }

  sanitizeHistory(history).forEach((item) => messages.push(item));

  messages.push({ role: 'user', content: message });

  return messages;
}

async function answerWithRepository({ audience, message, context, history }) {
  const vectorStore = await ensureVectorStore();
  if (!hasVectorStoreLoaded(vectorStore)) {
    return { ok: false, reason: 'missing_index' };
  }
  if (!isConfigured()) {
    return { ok: false, reason: 'missing_openai' };
  }

  const searchResult = await searchSimilarChunks(message);
  if (!searchResult.ok || !searchResult.results.length) {
    return { ok: false, reason: searchResult.reason || 'no_results' };
  }

  const relevant = searchResult.results.filter((item, idx) => item.score >= 0.2 || idx === 0);
  if (!relevant.length) {
    return { ok: false, reason: 'low_score' };
  }

  const snippets = relevant.map((item) => ({
    file: item.file,
    startLine: item.startLine,
    endLine: item.endLine,
    content: item.content,
    score: item.score,
  }));

  const client = getClient();
  if (!client) {
    return { ok: false, reason: 'missing_openai' };
  }

  const messages = buildRepoPrompt({ audience, context, codeSnippets: snippets, message, history });

  try {
    const completion = await client.chat.completions.create({
      model: openAiModel,
      temperature: 0.2,
      max_tokens: 800,
      messages,
    });

    const reply = completion?.choices?.[0]?.message?.content;
    if (!reply) {
      return { ok: false, reason: 'empty_response' };
    }

    return {
      ok: true,
      origin: 'repo',
      reply,
      references: snippets,
    };
  } catch (err) {
    return { ok: false, reason: 'openai_error', error: err };
  }
}

async function handleMessage({
  audience: rawAudience,
  message,
  userId,
  history,
  allowRepo = true,
}) {
  const audience = pickAudience(rawAudience);
  const context = await fetchContext(audience, userId);

  const knowledgeAnswer = await answerWithKnowledgeBase({ audience, message, context });
  if (knowledgeAnswer) {
    return {
      ...knowledgeAnswer,
      context,
    };
  }

  if (allowRepo) {
    const repoAnswer = await answerWithRepository({ audience, message, context, history });
    if (repoAnswer && repoAnswer.ok) {
      return {
        ...repoAnswer,
        intermediateNotice:
          'Sua dúvida não está pré-abastecida em meu banco de informações, mas não se preocupe: estou consultando o código da plataforma para montar a melhor resposta.',
        context,
      };
    }
  }

  return {
    origin: 'fallback',
    reply: buildFallbackMessage(),
    context,
  };
}

async function bootstrap({ audience: rawAudience, userId }) {
  const audience = pickAudience(rawAudience);
  const context = await fetchContext(audience, userId);
  const vectorStore = await ensureVectorStore();

  return {
    audience,
    context,
    suggestions: extractSuggestions(audience, 5),
    capabilities: {
      openAiConfigured: isConfigured(),
      vectorStoreReady: hasVectorStoreLoaded(vectorStore),
      knowledgeFlows: knowledgeBase
        .filter((flow) =>
          Array.isArray(flow.audiences) && (flow.audiences.includes(audience) || flow.audiences.includes('public'))
        )
        .map((flow) => ({ id: flow.id, title: flow.title })),
    },
    noticeDelay: knowledgeBaseNoticeDelayMs,
  };
}

module.exports = {
  handleMessage,
  bootstrap,
};
