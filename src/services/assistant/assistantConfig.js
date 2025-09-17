const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');

module.exports = {
  repoRoot,
  vectorStorePath: process.env.ASSISTANT_VECTOR_STORE
    ? path.resolve(process.cwd(), process.env.ASSISTANT_VECTOR_STORE)
    : path.resolve(repoRoot, 'config/assistant/vector-store.json'),
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  maxReferenceChunks: Number(process.env.ASSISTANT_MAX_REFERENCE_CHUNKS || 4),
  knowledgeBaseNoticeDelayMs: Number(process.env.ASSISTANT_NOTICE_DELAY || 650),
  fallbackEmail: process.env.ASSISTANT_FALLBACK_EMAIL || 'supcti@secti.al.gov.br',
};
