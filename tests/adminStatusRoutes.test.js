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

function loadAdminStatusRoutesWithAxiosStub(stub, options = {}) {
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

  if (options.childProcess) {
    restoreStubs.push(stubModule('child_process', options.childProcess));
  }

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

test('checkVpnConnectivity strictly matches TLS insecure flag values', async () => {
  const axiosStub = async () => ({ status: 204 });
  const { mod, modulePath } = loadAdminStatusRoutesWithAxiosStub(axiosStub);
  const { checkVpnConnectivity } = mod._private;

  const baseEnv = {
    VPN_HEALTHCHECK_URL: 'https://vpn.example/ping',
    VPN_HEALTHCHECK_METHOD: 'get',
    VPN_HEALTHCHECK_TIMEOUT_MS: '1000',
  };

  const truthyCases = ['true', 'TRUE', '  true  ', ' 1 '];
  for (const value of truthyCases) {
    // eslint-disable-next-line no-await-in-loop
    await withVpnEnv(
      { ...baseEnv, VPN_HEALTHCHECK_TLS_INSECURE: value },
      async () => {
        const result = await checkVpnConnectivity();
        assert.equal(
          result.insecureTls,
          true,
          `Expected "${value}" to enable insecure TLS`,
        );
      },
    );
  }

  const falsyCases = ['false', 'false1', '01', ' 0 ', '', 'true1'];
  for (const value of falsyCases) {
    // eslint-disable-next-line no-await-in-loop
    await withVpnEnv(
      { ...baseEnv, VPN_HEALTHCHECK_TLS_INSECURE: value },
      async () => {
        const result = await checkVpnConnectivity();
        assert.equal(
          result.insecureTls,
          false,
          `Expected "${value}" to keep insecure TLS disabled`,
        );
      },
    );
  }

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

test('checkVpnConnectivity faz fallback para ping quando HTTP falha', async () => {
  const axiosStub = async () => ({ status: 503 });
  const execStub = {
    exec: (command, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      setImmediate(() => cb(null, { stdout: 'ok', stderr: '' }));
      return { command };
    },
  };
  const { mod, modulePath } = loadAdminStatusRoutesWithAxiosStub(axiosStub, {
    childProcess: execStub,
  });
  const { checkVpnConnectivity, vpnServiceCheck } = mod._private;

  await withVpnEnv(
    {
      VPN_HEALTHCHECK_URL: 'https://vpn.example/health',
      VPN_HEALTHCHECK_METHOD: 'get',
      VPN_HEALTHCHECK_TIMEOUT_MS: '1000',
      VPN_HEALTHCHECK_HOST: 'vpn.local',
    },
    async () => {
      const result = await checkVpnConnectivity();
      assert.equal(result.method, 'ping');
      assert.equal(result.fallbackFrom, 'http');
      assert.match(result.previousHttpError, /Health-check HTTP 503/);

      const description = vpnServiceCheck.successDescription(result);
      assert.match(description, /falha do endpoint HTTP/);

      const meta = vpnServiceCheck.onSuccess(result).meta;
      assert.equal(meta.method, 'ping');
      assert.equal(meta.host, 'vpn.local');
      assert.equal(meta.fallbackFrom, 'http');
      assert.match(meta.previousHttpError, /HTTP 503/);
    },
  );

  delete require.cache[modulePath];
});

test('checkVpnConnectivity relata falha combinada quando HTTP e ping falham', async () => {
  const axiosStub = async () => {
    throw new Error('Erro HTTP simulado');
  };
  const execStub = {
    exec: (command, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      setImmediate(() => cb(new Error('Falha no ping simulado')));
      return { command };
    },
  };
  const { mod, modulePath } = loadAdminStatusRoutesWithAxiosStub(axiosStub, {
    childProcess: execStub,
  });
  const { checkVpnConnectivity } = mod._private;

  await withVpnEnv(
    {
      VPN_HEALTHCHECK_URL: 'https://vpn.example/health',
      VPN_HEALTHCHECK_METHOD: 'get',
      VPN_HEALTHCHECK_TIMEOUT_MS: '1000',
      VPN_HEALTHCHECK_HOST: 'vpn.local',
    },
    async () => {
      await assert.rejects(checkVpnConnectivity, (err) => {
        assert.match(err.message, /health-check HTTP \(Erro HTTP simulado\)/);
        assert.match(err.message, /ping \(Falha no ping simulado\)/);
        assert.equal(err.meta.host, 'vpn.local');
        assert.ok(err.cause.http instanceof Error);
        assert.ok(err.cause.ping instanceof Error);
        return true;
      });
    },
  );

  delete require.cache[modulePath];
});
