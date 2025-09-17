const fs = require('fs/promises');
const { vectorStorePath, openAiEmbeddingModel, maxReferenceChunks } = require('./assistantConfig');
const { getClient, isConfigured } = require('./openaiClient');

let cachedStore = null;

async function loadVectorStore() {
  if (cachedStore) {
    return cachedStore;
  }

  try {
    const filePath = vectorStorePath;
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.vectors)) {
      throw new Error('Formato inválido do arquivo de vetores.');
    }
    cachedStore = {
      ...parsed,
      filePath,
      missing: false,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      cachedStore = { vectors: [], missing: true, filePath: vectorStorePath };
    } else {
      cachedStore = { vectors: [], missing: true, filePath: vectorStorePath, error: err };
    }
  }

  return cachedStore;
}

async function ensureVectorStore() {
  const store = await loadVectorStore();
  return store;
}

function hasVectorStoreLoaded(store) {
  return Boolean(store && Array.isArray(store.vectors) && store.vectors.length);
}

function cosineSimilarity(a = [], b = []) {
  if (!a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedText(text) {
  const client = getClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY não configurada.');
  }
  const response = await client.embeddings.create({
    model: openAiEmbeddingModel,
    input: text,
  });
  if (!response || !response.data || !response.data.length) {
    throw new Error('Resposta inválida da API de embeddings.');
  }
  return response.data[0].embedding;
}

async function searchSimilarChunks(query, topK = maxReferenceChunks) {
  const store = await ensureVectorStore();
  if (!hasVectorStoreLoaded(store)) {
    return { ok: false, reason: 'empty', results: [], store };
  }
  if (!isConfigured()) {
    return { ok: false, reason: 'missing_openai', results: [], store };
  }

  const queryEmbedding = await embedText(query);

  const scored = store.vectors
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    ok: true,
    results: scored,
    store,
  };
}

module.exports = {
  ensureVectorStore,
  searchSimilarChunks,
  hasVectorStoreLoaded,
};
