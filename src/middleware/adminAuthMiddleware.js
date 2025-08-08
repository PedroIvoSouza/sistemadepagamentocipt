// src/middleware/adminAuthMiddleware.js
const jwt = require('jsonwebtoken');

function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  console.log('[DEBUG] authorization header:', authHeader);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado. Nenhum token fornecido.' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.log('[DEBUG] jwt.verify erro:', err.message);
      return res.status(403).json({ error: 'Acesso negado. Token inválido.' });
    }
    console.log('[DEBUG] jwt.verify decoded:', decoded);

    // opcionalmente, anexe ao req.user para facilitar:
    req.user = decoded;
    next();
  });
}

module.exports = adminAuthMiddleware;