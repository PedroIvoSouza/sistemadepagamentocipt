// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'cipt-api',
      script: 'src/index.js',      // <-- troque para o caminho correto do seu entrypoint
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Maceio',

        // TLS confiando na cadeia do OpenSSL do sistema + CA da SEFAZ
        NODE_OPTIONS: '--use-openssl-ca',
        NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/sefaz-hom.crt',

        // Preferível manter verificação de certificado (ajuste para 'true' só se for paliativo)
        SEFAZ_TLS_INSECURE: 'true',

        // Evita passar por proxy nos domínios da SEFAZ
        NO_PROXY: '.sefaz.al.gov.br,acessosefaz.hom.sefaz.al.gov.br,acessosefaz.sefaz.al.gov.br',

        // Logs de diagnóstico (opcional)
        SEFAZ_DEBUG: '1'
      }
    }
  ]
};

