// src/middleware/botAuthMiddleware.js
require('dotenv').config();
const crypto = require('crypto');

function mask(s='') {
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0,2) + '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-2);
}

module.exports = (req, res, next) => {
  // aceita header e (temporariamente) query ?key= para teste
  const got = (req.get('x-bot-key') || req.get('X-Bot-Key') || req.query.key || '').trim();
  const exp = (process.env.BOT_SHARED_KEY || '').trim();

  // logs de depuração (remova depois que validar)
  console.log(`[BOT AUTH] got.len=${got.length} got="${mask(got)}"`);
  console.log(`[BOT AUTH] exp.len=${exp.length}`);

  if (!exp) {
    console.error('[BOT AUTH] BOT_SHARED_KEY ausente no .env da API');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(exp, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};
