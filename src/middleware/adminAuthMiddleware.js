const jwt = require('jsonwebtoken');

function adminAuthMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acesso negado. Nenhum token fornecido.' });
    }

    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Acesso negado. Token inválido.' });
        }

        // A verificação crucial: o token DEVE ter a propriedade 'isAdmin: true'
        if (!decoded.isAdmin) {
            return res.status(403).json({ error: 'Acesso negado. Permissões insuficientes.' });
        }

        req.admin = decoded; // Anexa os dados do admin à requisição
        next();
    });
}

module.exports = adminAuthMiddleware;