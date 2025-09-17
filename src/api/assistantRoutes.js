const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const authorizeRole = require('../middleware/roleMiddleware');
const assistantService = require('../services/assistant/assistantService');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function readMessage(body) {
  const message = body?.message;
  if (!message || !String(message).trim()) {
    return null;
  }
  return String(message).trim();
}

function sendPayload(res, data) {
  res.json({
    ...data,
    timestamp: new Date().toISOString(),
  });
}

// ===== Permissionário (Portal) =====
router.get(
  '/portal/bootstrap',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const payload = await assistantService.bootstrap({ audience: 'permissionario', userId: req.user.id });
    sendPayload(res, payload);
  })
);

router.post(
  '/portal/message',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const message = readMessage(req.body);
    if (!message) {
      return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const payload = await assistantService.handleMessage({
      audience: 'permissionario',
      message,
      userId: req.user.id,
      history,
      allowRepo: true,
    });
    sendPayload(res, payload);
  })
);

// ===== Administrador =====
router.get(
  '/admin/bootstrap',
  adminAuthMiddleware,
  asyncHandler(async (req, res) => {
    const payload = await assistantService.bootstrap({ audience: 'admin', userId: req.user.id });
    sendPayload(res, payload);
  })
);

router.post(
  '/admin/message',
  adminAuthMiddleware,
  asyncHandler(async (req, res) => {
    const message = readMessage(req.body);
    if (!message) {
      return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const payload = await assistantService.handleMessage({
      audience: 'admin',
      message,
      userId: req.user.id,
      history,
      allowRepo: true,
    });
    sendPayload(res, payload);
  })
);

// ===== Cliente de Evento =====
router.get(
  '/eventos/bootstrap',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  asyncHandler(async (req, res) => {
    const payload = await assistantService.bootstrap({ audience: 'cliente_evento', userId: req.user.id });
    sendPayload(res, payload);
  })
);

router.post(
  '/eventos/message',
  authMiddleware,
  authorizeRole(['CLIENTE_EVENTO']),
  asyncHandler(async (req, res) => {
    const message = readMessage(req.body);
    if (!message) {
      return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const payload = await assistantService.handleMessage({
      audience: 'cliente_evento',
      message,
      userId: req.user.id,
      history,
      allowRepo: true,
    });
    sendPayload(res, payload);
  })
);

// ===== Público (sem autenticação) =====
router.get(
  '/public/bootstrap',
  asyncHandler(async (req, res) => {
    const audience = req.query?.audience || 'public';
    const payload = await assistantService.bootstrap({ audience, userId: null });
    sendPayload(res, payload);
  })
);

router.post(
  '/public/message',
  asyncHandler(async (req, res) => {
    const audience = req.body?.audience || req.query?.audience || 'public';
    const message = readMessage(req.body);
    if (!message) {
      return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const payload = await assistantService.handleMessage({
      audience,
      message,
      userId: null,
      history,
      allowRepo: true,
    });
    sendPayload(res, payload);
  })
);

module.exports = router;
