/**
 * utilidades compartilhadas para integração com Assinafy
 */
function scanForSigningUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;

  const candidates = [
    obj.sign_url, obj.signer_url, obj.signerUrl, obj.signing_url,
    obj.url, obj.link, obj.signUrl, obj.deep_link, obj.deeplink,
    obj.access_link, obj.public_link,
  ].filter(Boolean);

  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
    if (typeof c === 'string' && c.startsWith('/verify/')) {
      return `https://app.assinafy.com.br${c}`;
    }
  }

  if (obj.assignment) {
    const x = scanForSigningUrl(obj.assignment, depth + 1);
    if (x) return x;
  }
  if (Array.isArray(obj.assignments)) {
    for (const it of obj.assignments) {
      const x = scanForSigningUrl(it, depth + 1);
      if (x) return x;
    }
  }

  if (Array.isArray(obj)) {
    for (const it of obj) {
      const found = scanForSigningUrl(it, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const keys = Object.keys(obj);
  for (const k of keys) {
    if (/assign|sign/i.test(k)) {
      const found = scanForSigningUrl(obj[k], depth + 1);
      if (found) return found;
    }
  }
  for (const k of keys) {
    const val = obj[k];
    if (val && typeof val === 'object') {
      const found = scanForSigningUrl(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizeAssinafyStatus(status, hasSignedPdf) {
  const st = String(status || '').toLowerCase().trim();
  if (hasSignedPdf) return 'assinado';
  if (['assinado', 'signed', 'completed', 'certified', 'certificated'].includes(st)) {
    return 'assinado';
  }
  return st || 'gerado';
}

module.exports = { scanForSigningUrl, normalizeAssinafyStatus };
