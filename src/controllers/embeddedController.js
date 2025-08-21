// src/controllers/embeddedController.js
const {
  verifySignerCode,
  acceptTerms,
  signVirtualDocuments,
  downloadSignedPdf,
  getDocumentStatus,
} = require('../services/assinafyClient');

// POST /api/embedded/verify  { signer_access_code, verification_code }
async function verifyController(req, res) {
  try {
    const { signer_access_code, verification_code } = req.body || {};
    if (!signer_access_code || !verification_code) throw new Error('Informe signer_access_code e verification_code.');
    const r = await verifySignerCode({ signer_access_code, verification_code });
    res.json({ ok: true, data: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

// PUT /api/embedded/accept-terms  { signer_access_code }
async function acceptTermsController(req, res) {
  try {
    const { signer_access_code } = req.body || {};
    if (!signer_access_code) throw new Error('Informe signer_access_code.');
    const r = await acceptTerms({ signer_access_code });
    res.json({ ok: true, data: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

// PUT /api/embedded/sign  { signer_access_code, document_id | document_ids[] }
async function signVirtualController(req, res) {
  try {
    const { signer_access_code, document_id, document_ids } = req.body || {};
    const ids = Array.isArray(document_ids) ? document_ids : (document_id ? [document_id] : []);
    if (!signer_access_code || ids.length === 0) throw new Error('Informe signer_access_code e ao menos um document_id.');
    const r = await signVirtualDocuments(signer_access_code, ids);
    res.json({ ok: true, data: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

// GET /api/embedded/documents/:id/certificated  (proxy de download)
async function downloadCertificatedController(req, res) {
  try {
    const { id } = req.params;
    // opcional: checar status antes de baixar
    const statusResp = await getDocumentStatus(id);
    const status = statusResp?.data?.status || statusResp?.status;
    if (status !== 'certificated') {
      return res.status(409).json({ ok: false, error: `Documento ainda não está 'certificated' (atual: ${status || 'desconhecido'})` });
    }
    const pdf = await downloadSignedPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="documento-certificado-${id}.pdf"`);
    return res.send(pdf);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

module.exports = {
  verifyController,
  acceptTermsController,
  signVirtualController,
  downloadCertificatedController,
};
