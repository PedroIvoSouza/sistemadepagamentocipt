// tests/adminStatusRoutes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const original = require.cache[resolved];
  require.cache[resolved] = { exports };
  return () => {
    if (original) {
      require.cache[resolved] = original;
    } else {
      delete require.cache[resolved];
    }
  };
}

function loadAdminStatusRoutesWithAxiosStub(stub) {
  const modulePath = require.resolve('../src/api/adminStatusRoutes.js');
  delete require.cache[modulePath];

  const restoreStubs = [
    stubModule('../src/middleware/adminAuthMiddleware.js', () => (_req, _res, next) => next()),
    stubModule('../src/middleware/roleMiddleware.js', () => (_roles) => (_req, _res, next) => next()),
    stubModule('../src/database/db.js', {
      get: (_query, callback) => {
        if (typeof callback === 'function') callback(null, { ok: 1 });
      },
    }),
    stubModule('../src/services/emailService.js', {
      verifySmtpConnection: async () => {},
    }),
    stubModule('../src/services/sefazService.js', {
      checkSefazHealth: async () => {},
    }),
    stubModule('../src/services/whatsappService.js', {
      checkHealth: async () => {},
    }),
    stubModule('../src/services/assinafyService.js', {
      checkAssinafyHealth: async () => ({}),
    }),
    stubModule('../src/services/cnpjLookupService.js', {
      fetchCnpjData: async () => ({}),
    }),
    stubModule('../src/services/cepLookupService.js', {
      fetchCepAddress: async () => ({}),
    }),
  ];

  const axiosPath = require.resolve('axios');
  const originalAxiosModule = require.cache[axiosPath];
  require.cache[axiosPath] = { exports: stub };

  const mod = require(modulePath);

  if (originalAxiosModule) {
    require.cache[axiosPath] = originalAxiosModule;
  } else {
    delete require.cache[axiosPath];
  }

  for (const restore of restoreStubs.reverse()) {
    restore();
  }

  return { mod, modulePath };
}

function withVpnEnv(env, fn) {
  const keys = Object.keys(env);
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return fn().finally(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test('checkVpnConnectivity reports insecure TLS on success responses', async () => {
  const axiosStub = async () => ({ status: 204 });
  const { mod, modulePath } = loadAdminStatusRoutesWithAxiosStub(axiosStub);
  const { checkVpnConnectivity, vpnServiceCheck } = mod._private;

  await withVpnEnv(
    {
      VPN_HEALTHCHECK_URL: 'https://vpn.example/ping',
      VPN_HEALTHCHECK_METHOD: 'get',
      VPN_HEALTHCHECK_TIMEOUT_MS: '1500',
      VPN_HEALTHCHECK_TLS_INSECURE: 'true',
    },
    async () => {
      const result = await checkVpnConnectivity();
      assert.equal(result.method, 'http');
      assert.equal(result.insecureTls, true);
      const description = vpnServiceCheck.successDescription(result);
      assert.match(description, /TLS inseguro habilitado/);
      assert.equal(vpnServiceCheck.onSuccess(result).meta.insecureTls, true);
    },
  );

  delete require.cache[modulePath];
});

test('checkVpnConnectivity propagates insecure TLS context on failures', async () => {
  const axiosStub = async () => ({ status: 503 });
  const { mod, modulePath } = loadAdminStatusRoutesWithAxiosStub(axiosStub);
  const { checkVpnConnectivity, vpnServiceCheck } = mod._private;

  await withVpnEnv(
    {
      VPN_HEALTHCHECK_URL: 'https://vpn.example/ping',
      VPN_HEALTHCHECK_METHOD: 'post',
      VPN_HEALTHCHECK_TIMEOUT_MS: '2000',
      VPN_HEALTHCHECK_TLS_INSECURE: '1',
    },
    async () => {
      let captured;
      await assert.rejects(checkVpnConnectivity, (err) => {
        captured = err;
        assert.ok(err.meta, 'Expected error.meta to be defined');
        assert.equal(err.meta.insecureTls, true);
        assert.equal(err.meta.url, 'https://vpn.example/ping');
        assert.equal(err.meta.method, 'http');
        return true;
      });

      const context = captured.meta;
      const extra = vpnServiceCheck.onError({ meta: context }, { message: captured.message });
      assert.match(extra.description, /TLS inseguro habilitado/);
      assert.deepEqual(extra.meta, context);
    },
  );

  delete require.cache[modulePath];
});
