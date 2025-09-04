const QRCode = require('qrcode');

const BASE_URL = 'https://permissionarios.portalcipt.com.br/verificar-token.html?token=';

async function generateTokenQr(token) {
  const url = `${BASE_URL}${token}`;
  return QRCode.toBuffer(url, { type: 'png' });
}

module.exports = generateTokenQr;
