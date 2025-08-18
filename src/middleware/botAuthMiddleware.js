// src/middleware/botAuthMiddleware.js
require('dotenv').config();

module.exports = (req, res, next) => {
  const got = (req.get('x-bot-key') || '').trim();
  const exp = (process.env.BOT_SHARED_KEY || '').trim();

  // LOGS de depuração (remova depois que testar)
  console.log('[BOT AUTH] recv len=', got.length);
  console.log('[BOT AUTH] env  len=', exp.length);

  if (!exp) {
    console.error('[BOT AUTH] BOT_SHARED_KEY ausente no .env');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  if (got !== exp) return res.status(401).json({ error: 'Unauthorized' });

  return next();
};
