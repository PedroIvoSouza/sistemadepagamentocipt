const OpenAI = require('openai');

let cachedClient = null;

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey });
  }
  return cachedClient;
}

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

module.exports = {
  getClient,
  isConfigured,
};
