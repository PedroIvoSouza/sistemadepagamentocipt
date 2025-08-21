// src/routes/assinafy.js
const express = require('express');
const { prepararSemCamposController } = require('../controllers/termoController');
const {
  verifyController,
  acceptTermsController,
  signVirtualController,
  downloadCertificatedController,
} = require('../controllers/embeddedController');

const router = express.Router();

// Botão ADM: disponibilizar p/ assinatura (SEM CAMPOS) já informando Nome/Email
router.post('/eventos/:id/termo/preparar', express.json(), prepararSemCamposController);

// Fluxo embedded (no seu front você pede o código 6 dígitos ao usuário)
router.post('/embedded/verify', express.json(), verifyController);
router.put('/embedded/accept-terms', express.json(), acceptTermsController);
router.put('/embedded/sign', express.json(), signVirtualController);

// Download do PDF certificado (server->server)
router.get('/embedded/documents/:id/certificated', downloadCertificatedController);

module.exports = router;
