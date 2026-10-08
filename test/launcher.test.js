import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLoopbackPortFree, ensureEndpoint, launchArguments, macAppBundle, restartMacApp, restartSelectedApp } from '../src/launcher.js';
import { createServer } from 'node:net';

const options = (overrides = {}) => ({ endpoint: 'http://127.0.0.1:9222', ...overrides });
const noWait = async () => {};

test('restart resolves the selected app before touching a reachable endpoint', async () => {
  const events = [];
  let checks = 0;
  await ensureEndpoint(options({ restart: true }), () => {}, {
    targets: async () => { checks += 1; return [{ id: 'already-open' }]; },
    findApp: async () => { events.push('resolve'); return '/apps/selected'; },
    restartSelectedApp: async (app) => { events.push(`quit:${app}`); },
    assertPortFree: async () => { events.push('port-free'); },
    startApp: async (app, endpoint) => { events.push(`launch:${app}:${launchArguments(endpoint).join(',')}`); },
    delay: noWait,
  });
  assert.deepEqual(events, [
    'resolve', 'quit:/apps/selected',
    'port-free',
    'launch:/apps/selected:--remote-debugging-address=127.0.0.1,--remote-debugging-port=9222',
  ]);
  assert.equal(checks, 1);
});

test('restart requests shutdown only for the resolved selected app and waits before opening it', async () => {
  const events = [];
  let running = true;
  await ensureEndpoint(options({ restart: true }), () => {}, {
    targets: async () => { events.push('cdp-check'); if (events.includes('launch')) return []; throw new Error('not ready'); },
    findApp: async () => '/Applications/Chosen.app/Contents/MacOS/Chosen',
    restartSelectedApp: async (app) => {
      events.push(`quit:${app}`);
      events.push('wait-for-exit');
      running = false;
      assert.equal(running, false);
    },
    assertPortFree: async () => { events.push('port-free'); },
    startApp: async (app) => { assert.equal(running, false); events.push('launch'); },
    delay: noWait,
  });
  assert.deepEqual(events.slice(0, 5), [
    'quit:/Applications/Chosen.app/Contents/MacOS/Chosen', 'wait-for-exit', 'port-free', 'launch', 'cdp-check',
  ]);
});

test('a refused quit or shutdown timeout prevents a new launch', async () => {
  let launches = 0;
  await assert.rejects(ensureEndpoint(options({ restart: true }), () => {}, {
    targets: async () => { throw new Error('currently reachable but restart is requested'); },
    findApp: async () => '/apps/selected',
    restartSelectedApp: async () => { throw new Error('The selected app did not exit after a normal quit request; it was not relaunched.'); },
    assertPortFree: async () => {},
    startApp: async () => { launches += 1; },
  }), /did not exit/);
  assert.equal(launches, 0);
});

test('a stopped selected app launches without issuing a quit', async () => {
  const events = [];
  await ensureEndpoint(options({ restart: true }), () => {}, {
    targets: async () => events.includes('launch') ? [] : Promise.reject(new Error('CDP currently unavailable')),
    findApp: async () => '/apps/stopped',
    restartSelectedApp: async (app) => { events.push(`check-and-quit-if-running:${app}`); },
    assertPortFree: async () => {},
    startApp: async () => { events.push('launch'); },
    delay: noWait,
  });
  assert.deepEqual(events, ['check-and-quit-if-running:/apps/stopped', 'launch']);
});

test('default behavior connects to reachable CDP without resolving or launching an app', async () => {
  let resolves = 0;
  let launches = 0;
  await ensureEndpoint(options(), () => {}, {
    targets: async () => [{ id: 'already-open' }],
    findApp: async () => { resolves += 1; throw new Error('should not resolve'); },
    startApp: async () => { launches += 1; },
  });
  assert.equal(resolves, 0);
  assert.equal(launches, 0);
});

test('default behavior launches after an unreachable endpoint', async () => {
  const events = [];
  let checks = 0;
  await ensureEndpoint(options({ startTimeoutMs: 100 }), () => {}, {
    targets: async () => { checks += 1; if (checks === 1) throw new Error('unavailable'); return []; },
    findApp: async () => '/apps/selected',
    startApp: async (app) => { events.push(`launch:${app}`); },
    delay: noWait,
  });
  assert.deepEqual(events, ['launch:/apps/selected']);
  assert.equal(checks, 2);
});

test('macOS restart derives the selected bundle and targets its exact path', async () => {
  const executable = '/Applications/Chosen.app/Contents/MacOS/Chosen';
  assert.equal(macAppBundle(executable), '/Applications/Chosen.app');
  assert.throws(() => macAppBundle('/usr/local/bin/codex-desktop'), /inside a \.app bundle/);
  const calls = [];
  const native = async (command, args) => {
    calls.push({ command, args });
    if (command === 'defaults') return { stdout: 'com.example.chosen\n' };
    if (calls.length === 2) return { stdout: 'quit-requested' };
    return { stdout: 'stopped' };
  };
  await restartMacApp(executable, 1000, native, async (path) => path);
  assert.deepEqual(calls[0].args, ['read', '/Applications/Chosen.app/Contents/Info', 'CFBundleIdentifier']);
  assert.deepEqual(calls[1].args.slice(-2), ['com.example.chosen', '/Applications/Chosen.app']);
  assert.deepEqual(calls[2].args.slice(-2), ['com.example.chosen', '/Applications/Chosen.app']);
  assert.match(calls[1].args[3], /NSRunningApplication/);
  assert.match(calls[1].args[3], /!app\.terminate/);
  assert.match(calls[1].args[3], /NSString\.stringWithString\(argv\[1\]\)/);
});

test('macOS restart skips quit for a stopped app and propagates refused or timed-out quits', async () => {
  const executable = '/Applications/Chosen.app/Contents/MacOS/Chosen';
  let calls = 0;
  const notRunning = async (command) => {
    calls += 1;
    return { stdout: command === 'defaults' ? 'com.example.chosen' : 'not-running' };
  };
  await restartMacApp(executable, 1000, notRunning, async (path) => path);
  assert.equal(calls, 2);

  const refused = async (command) => {
    if (command === 'defaults') return { stdout: 'com.example.chosen' };
    throw new Error('The selected app refused the normal quit request.');
  };
  await assert.rejects(restartMacApp(executable, 1000, refused, async (path) => path), /refused/);

  let stateChecks = 0;
  const staysRunning = async (command) => {
    if (command === 'defaults') return { stdout: 'com.example.chosen' };
    stateChecks += 1;
    return { stdout: stateChecks === 1 ? 'quit-requested' : 'running' };
  };
  await assert.rejects(restartMacApp(executable, 1, staysRunning, async (path) => path), /did not exit/);
  assert.equal(stateChecks, 2);

  const unknownStatus = async (command) => ({ stdout: command === 'defaults' ? 'com.example.chosen' : 'unexpected' });
  await assert.rejects(restartMacApp(executable, 1000, unknownStatus, async (path) => path), /Unexpected macOS quit status/);
});

test('loopback port preflight detects a real listener and passes after it closes', async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  try { await assert.rejects(assertLoopbackPortFree(endpoint), /still occupied/); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  await assertLoopbackPortFree(endpoint);
});

test('busy port after restart aborts before CDP discovery or launch', async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const events = [];
  let checks = 0;
  let launches = 0;
  try {
    await assert.rejects(ensureEndpoint(options({ endpoint: `http://127.0.0.1:${server.address().port}`, restart: true }), () => {}, {
      targets: async () => { checks += 1; return [{ id: 'unrelated-process' }]; },
      findApp: async () => '/apps/selected',
      restartSelectedApp: async () => { events.push('quit'); },
      startApp: async () => { launches += 1; },
    }), /still occupied/);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  assert.deepEqual(events, ['quit']);
  assert.equal(checks, 0);
  assert.equal(launches, 0);
});

test('abort before quit and during shutdown polling prevents reopen', async () => {
  const controller = new AbortController();
  let quits = 0;
  await assert.rejects(ensureEndpoint(options({ restart: true, signal: controller.signal }), () => {}, {
    findApp: async () => { controller.abort(); return '/apps/selected'; },
    restartSelectedApp: async () => { quits += 1; },
    assertPortFree: async () => {},
    startApp: async () => { throw new Error('must not launch'); },
  }), { name: 'AbortError' });
  assert.equal(quits, 0);

  const duringPolling = new AbortController();
  const executable = '/Applications/Chosen.app/Contents/MacOS/Chosen';
  let shutdownChecks = 0;
  const native = async (command) => {
    if (command === 'defaults') return { stdout: 'com.example.chosen' };
    shutdownChecks += 1;
    if (shutdownChecks === 1) {
      return { stdout: 'quit-requested' };
    }
    duringPolling.abort();
    return { stdout: 'running' };
  };
  await assert.rejects(restartMacApp(executable, 1000, native, async (path) => path, duringPolling.signal), { name: 'AbortError' });
  assert.equal(shutdownChecks, 2);
});

test('abort immediately before opening prevents spawn', async () => {
  const controller = new AbortController();
  let launches = 0;
  await assert.rejects(ensureEndpoint(options({ restart: true, signal: controller.signal }), () => {}, {
    findApp: async () => '/apps/selected',
    restartSelectedApp: async () => {},
    assertPortFree: async () => { controller.abort(); },
    startApp: async () => { launches += 1; },
  }), { name: 'AbortError' });
  assert.equal(launches, 0);
});

test('abort during CDP readiness wait prevents continued discovery', async () => {
  const controller = new AbortController();
  let checks = 0;
  let launches = 0;
  await assert.rejects(ensureEndpoint(options({ restart: true, signal: controller.signal }), () => {}, {
    findApp: async () => '/apps/selected',
    restartSelectedApp: async () => {},
    assertPortFree: async () => {},
    startApp: async () => { launches += 1; },
    targets: async () => { checks += 1; setTimeout(() => controller.abort(), 0); throw new Error('not ready'); },
  }), { name: 'AbortError' });
  assert.equal(launches, 1);
  assert.equal(checks, 1);
});

test('restart fails before launch on unsupported platforms', async () => {
  await assert.rejects(restartSelectedApp('/apps/selected', {}, 'linux'), /supported on macOS and Windows/);
});
