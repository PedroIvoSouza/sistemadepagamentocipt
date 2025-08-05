// src/middleware/roleMiddleware.js

function authorizeRole(allowedRoles) {
    return (req, res, next) => {
        // Pega o usuário que foi decodificado pelo authMiddleware
        const user = req.user;

        if (!user || !user.role) {
            return res.status(403).json({ error: 'Acesso negado. Nível de permissão não encontrado.' });
        }

        // Verifica se a 'role' do usuário está na lista de 'roles' permitidas
        if (allowedRoles.includes(user.role)) {
            next(); // Permissão concedida, pode prosseguir para a rota
        } else {
            return res.status(403).json({ error: 'Acesso negado. Você não tem permissão para executar esta ação.' });
        }
    };
}

module.exports = authorizeRole;