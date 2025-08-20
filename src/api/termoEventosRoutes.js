const express = require('express');
const router = express.Router();
const { gerarTermoEventoEIndexar } = require('../services/termoEventoExportService');

router.post('/:eventoId/gerar-termo', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const out = await gerarTermoEventoEIndexar(eventoId);
    return res.json({
      ok: true,
      documentoId: out.documentoId,
      token: out.token,
      pdf_path: out.filePath,
      pdf_public_url: out.pdf_public_url,
      url_visualizacao: out.urlTermoPublic
    });
  } catch (err) {
    console.error('[termo eventos] erro:', err);
    return res.status(500).json({ ok:false, error: 'Falha ao gerar termo.' });
  }
});

module.exports = router;
