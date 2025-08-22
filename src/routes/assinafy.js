// src/routes/assinafy.js  (já deve existir do passo anterior)
const express = require('express');
const { prepararSemCamposController } = require('../controllers/termoController');

const {
  verifyController,
  acceptTermsController,
  signVirtualController,
  downloadCertificatedController,
} = require('../controllers/embeddedController');

const router = express.Router();

// ADM clica no botão -> prepara com Nome/Email (pode vir no body)
router.post('/eventos/:id/termo/preparar', express.json(), prepararSemCamposController);

// fluxo embedded do cliente
router.post('/embedded/verify', express.json(), verifyController);
router.put('/embedded/accept-terms', express.json(), acceptTermsController);
router.put('/embedded/sign', express.json(), signVirtualController);

// baixa certificado APENAS quando status==certificated
router.get('/embedded/documents/:id/certificated', downloadCertificatedController);

module.exports = router;
