const knowledgeBase = require('./knowledgeBase');

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeScore(flow, normalizedMessage) {
  if (!flow || !Array.isArray(flow.keywords) || !flow.keywords.length) {
    return { score: 0, matches: 0 };
  }

  let score = 0;
  let matches = 0;
  for (const group of flow.keywords) {
    const tokens = Array.isArray(group) ? group : [group];
    if (!tokens.length) continue;
    const groupMatch = tokens.every((tokenRaw) => {
      const token = normalize(tokenRaw);
      if (!token) return false;
      return normalizedMessage.includes(token);
    });
    if (groupMatch) {
      matches += 1;
      score += tokens.length;
    }
  }

  return { score, matches };
}

function matchKnowledgeBase({ message, audience = 'public' }) {
  const normalizedMessage = normalize(message);
  if (!normalizedMessage) {
    return null;
  }

  let best = null;

  for (const flow of knowledgeBase) {
    const audiences = Array.isArray(flow.audiences) ? flow.audiences : [];
    if (!audiences.includes(audience) && !audiences.includes('public')) {
      continue;
    }

    const { score, matches } = computeScore(flow, normalizedMessage);
    if (!score) continue;

    const minScore = typeof flow.minScore === 'number' ? flow.minScore : 1;
    if (score < minScore) continue;

    if (!best) {
      best = { flow, score, matches };
      continue;
    }

    if (score > best.score) {
      best = { flow, score, matches };
      continue;
    }

    if (score === best.score) {
      const currentPriority = flow.priority || 0;
      const bestPriority = best.flow.priority || 0;
      if (currentPriority > bestPriority) {
        best = { flow, score, matches };
      }
    }
  }

  return best;
}

module.exports = {
  normalize,
  matchKnowledgeBase,
};
