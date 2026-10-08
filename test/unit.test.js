import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointURL, debuggerURL, targets } from '../src/cdp.js';
import { argumentsFor } from '../src/cli.js';
import { launchArguments } from '../src/launcher.js';
import { lock, readJSON, writeJSON } from '../src/state.js';
import { createServer } from 'node:http';

test('only explicit loopback HTTP origins are accepted', () => {
  for (const value of ['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222']) assert.ok(endpointURL(value));
  for (const value of ['https://127.0.0.1:9222', 'http://example.com:9222', 'http://127.0.0.1', 'http://127.0.0.1:80', 'http://user:secret@localhost:9222', 'http://localhost:9222/path', 'http://localhost:9222/?token=x']) assert.throws(() => endpointURL(value));
});

test('debugger URLs cannot escape the endpoint or connect to a browser target', () => {
  assert.match(debuggerURL('ws://localhost:9222/devtools/page/abc-123', 'http://127.0.0.1:9222'), /abc-123/);
  for (const value of ['ws://evil.example:9222/devtools/page/id', 'ws://localhost:9223/devtools/page/id', 'ws://localhost:9222/devtools/browser/id', 'ws://localhost:9222/devtools/page/id?x=1', 'wss://localhost:9222/devtools/page/id']) assert.throws(() => debuggerURL(value, 'http://127.0.0.1:9222'));
});

test('CLI validates commands, plugin IDs and refresh settings', () => {
  assert.equal(argumentsFor(['enable', 'sidebar-time']).timeField, 'recency');
  assert.equal(argumentsFor(['doctor']).command, 'doctor');
  assert.ok(argumentsFor(['--help']).help);
  for (const args of [['enable', 'other'], ['doctor', 'sidebar-time'], ['enable', 'sidebar-time', '--refresh-ms', '0'], ['enable', 'sidebar-time', '--time-field', 'banana'], ['enable', 'sidebar-time', '--endpoint', 'http://evil.example:9222']]) assert.throws(() => argumentsFor(args));
});

test('launcher never adds sandbox, signing, or profile overrides', () => {
  assert.deepEqual(launchArguments('http://127.0.0.1:9222'), ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222']);
});

test('discovery filters unrelated pages and forged WebSockets', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const port = server.address().port;
    response.end(JSON.stringify([
      { id: 'official', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/official` },
      { id: 'browser', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/browser` },
      { id: 'forged', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://evil.example:${port}/devtools/page/forged` },
    ]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.deepEqual((await targets(`http://127.0.0.1:${server.address().port}`)).map(item => item.id), ['official']); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('state writes are atomic and watcher ownership is exclusive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mods-state-'));
  try {
    await writeJSON(directory, 'config.json', { enabled: true });
    assert.equal((await readJSON(directory, 'config.json')).enabled, true);
    const release = await lock(directory);
    await assert.rejects(lock(directory), /already running/);
    await release();
    const releaseAgain = await lock(directory);
    await releaseAgain();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
