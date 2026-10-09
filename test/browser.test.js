import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { payload, cleanupExpression } from '../src/renderer.js';
import { targets, CDP } from '../src/cdp.js';

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Codex Mods compatibility fixture</title>
<style>
body{margin:0;background:#f8f5ef;color:#65617c;font:15px system-ui}aside{width:min(370px,90vw);padding:18px;border-right:1px solid #e0dcd5}h2{font-size:16px}button{display:flex;align-items:center;gap:4px;width:100%;padding:12px 8px;margin:4px 0;border:0;border-radius:10px;background:transparent;color:inherit;text-align:left;font:inherit}button:hover{background:#ece8e2}.title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status{flex-shrink:0}main{padding:20px}#clicked{margin:12px}
</style></head><body><aside data-sidebar><h2>Example project</h2>
<button data-app-action-sidebar-thread-id="local:a"><span class="title">Investigate task generation</span><span class="status">○</span></button>
<button data-app-action-sidebar-thread-id="local:b"><span class="title">Review workflow safeguards</span><span class="status">↗</span></button>
<button data-app-action-sidebar-thread-id="local:c"><span class="title">Improve layout</span><span class="status">↗</span></button>
</aside><main><a href="/thread/a" id="outside">Link in a message, not the sidebar</a><p id="clicked">No thread selected</p></main>
<script>
const now=Math.floor(Date.now()/1000);
window.snapshot={catalogSnapshot:{entries:[{id:'a',recencyAt:now-5*60,updatedAt:now-60},{id:'b',recencyAt:now-14*3600},{id:'c',updatedAt:now-3*86400}]}};
window.electronBridge={getInitialSidebarBootstrap:()=>window.snapshot};
document.querySelector('aside').addEventListener('click',event=>{const row=event.target.closest('button');if(row)document.querySelector('#clicked').textContent=row.querySelector('.title').textContent});
</script></body></html>`;
let browser, page, server, origin, endpoint;
const errors = [];
const cliPath = process.env.CODEX_MODS_BIN || fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

before(async () => {
  server = createServer((request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(fixture); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
});

after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

const go = () => page.goto(origin);
const install = options => page.evaluate(payload({ refreshMs: 1000, ...options }));
const badges = () => page.locator('[data-codex-mods-time]').allTextContents();
const row = id => page.locator(`[data-app-action-sidebar-thread-id="local:${id}"]`);
async function waitFor(predicate, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(message);
}

test('rendered badges use recency, preserve titles/actions, and stay in the sidebar', async () => {
  await go();
  assert.equal(await page.title(), 'Codex Mods compatibility fixture');
  assert.equal(page.url(), origin + '/');
  assert.ok((await page.locator('body').innerText()).includes('Example project'));
  assert.equal(await page.locator('vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay').count(), 0);
  const state = await install();
  assert.equal(state.badges, 3);
  assert.deepEqual(await badges(), ['5m', '14h', '3d']);
  assert.equal(await row('b').locator('.title').textContent(), 'Review workflow safeguards');
  assert.equal(await page.locator('#outside [data-codex-mods-time]').count(), 0);
  await row('b').click();
  assert.equal(await page.locator('#clicked').textContent(), 'Review workflow safeguards');
  assert.ok(await row('b').locator('[data-codex-mods-time]').getAttribute('title'));
  assert.match(await row('b').locator('[data-codex-mods-time]').getAttribute('aria-label'), /Last activity/);
  await page.screenshot({ path: join(tmpdir(), 'codex-mods-sidebar-desktop.png') });
});

test('session sizes use subtle background fills and preserve titles, status, and click behavior', async () => {
  await go();
  const state = await install({ showSize: true, sessionSizes: { a: 2 * 1024 ** 2, b: 128 * 1024 ** 2, c: 0 } });
  assert.equal(state.badges, 3);
  assert.equal(state.sizeBadges, 3);
  assert.deepEqual(await page.locator('[data-codex-mods-size]').allTextContents(), ['2.0 MiB', '128 MiB', '0 B']);
  const fills = await page.locator('[data-codex-mods-fill]').evaluateAll(rows => rows.map(row => parseFloat(row.style.getPropertyValue('--codex-mods-fill'))));
  assert.ok(fills[1] > fills[0] && fills[0] > fills[2]);
  assert.match(await row('a').locator('[data-codex-mods-size]').getAttribute('title'), /2,097,152 bytes/);
  await row('b').locator('[data-codex-mods-size]').click();
  assert.equal(await page.locator('#clicked').textContent(), 'Review workflow safeguards');
  for (const width of [1100, 390]) {
    await page.setViewportSize({width, height: 650});
    for (const id of ['a', 'b', 'c']) {
      const parent = await row(id).boundingBox();
      const size = await row(id).locator('[data-codex-mods-size]').boundingBox();
      const status = await row(id).locator('.status').boundingBox();
      assert.ok(size.x >= parent.x && size.x + size.width < status.x);
      assert.ok(status.x + status.width <= parent.x + parent.width);
    }
  }
  await page.mouse.move(380,300);
  await page.locator('aside').screenshot({path: join(tmpdir(), 'codex-mods-size-light.png')});
  await page.addStyleTag({content:'body{background:#202123;color:#dedee2}aside{border-color:#393a3c}button:hover{background:#303134}'});
  await page.locator('aside').screenshot({path: join(tmpdir(), 'codex-mods-size-dark.png')});
  await page.setViewportSize({width:1100,height:650});
  await page.evaluate(cleanupExpression);
  assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill], [data-codex-mods-style]').count(), 0);
  assert.equal(await row('a').evaluate(row => row.style.getPropertyValue('--codex-mods-fill')), '');
});

test('size-only mode works without timestamps and omits remote, ambiguous, and missing records', async () => {
  await go();
  await page.evaluate(() => {
    document.querySelector('aside').innerHTML = '<button data-app-action-sidebar-thread-id="local:a">Local</button><button data-app-action-sidebar-thread-id="ssh:a">Remote</button><button data-thread-id="a">Ambiguous</button><button data-app-action-sidebar-thread-id="local:missing">Missing</button>';
    window.snapshot.catalogSnapshot.entries = [{id:'a',hostId:'local'}, {id:'a',hostId:'ssh'}];
  });
  const state = await install({showTime:false,showSize:true,sessionSizes:{a:2048}});
  assert.equal(state.badges, 0);
  assert.equal(state.sizeBadges, 1);
  assert.deepEqual(await page.locator('[data-codex-mods-size]').allTextContents(), ['2.0 KiB']);
  await page.evaluate(() => {
    globalThis.__codexModsSidebarTime.setSessionSizes({a:4096},null,1);
    const row = document.querySelector('[data-app-action-sidebar-thread-id="local:a"]');
    row.replaceChildren(document.createTextNode('Local'));
  });
  await waitFor(async () => (await page.locator('[data-codex-mods-size]').textContent()) === '4.0 KiB', 'Size did not recover after a row replacement');
  await page.evaluate(() => globalThis.__codexModsSidebarTime.setSessionSizes({},'Record scan incomplete',2));
  assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill]').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__codexModsSidebarTime.status().warning), 'Record scan incomplete');
});

test('native background images remain intact while session size values are displayed', async () => {
  await go();
  await row('a').evaluate(row => {row.style.backgroundImage = 'linear-gradient(red, blue)';});
  await install({showSize:true,sessionSizes:{a:4096}});
  assert.equal(await row('a').locator('[data-codex-mods-size]').count(), 1);
  assert.equal(await row('a').getAttribute('data-codex-mods-fill'), null);
  assert.equal(await row('a').evaluate(row => row.style.backgroundImage), 'linear-gradient(red, blue)');
});

test('React-style row replacement and live metadata updates restore the correct badges', async () => {
  await go(); await install();
  await page.evaluate(() => {
    const row = document.querySelector('[data-app-action-sidebar-thread-id="local:b"]');
    row.replaceChildren();
    const title = document.createElement('span'); title.className = 'title'; title.textContent = 'Review workflow safeguards'; row.append(title);
    window.snapshot.catalogSnapshot.entries[1].recencyAt = Math.floor(Date.now()/1000) - 120;
  });
  await waitFor(async () => (await badges()).includes('2m'), 'Metadata did not refresh');
  assert.equal(await row('b').locator('[data-codex-mods-time]').count(), 1);
  await page.evaluate(() => {
    const row = document.querySelector('[data-app-action-sidebar-thread-id="local:a"]');
    row.setAttribute('data-app-action-sidebar-thread-id', 'local:missing');
  });
  await waitFor(async () => (await badges()).length === 2, 'Recycled row kept a stale badge');
});

test('host-qualified IDs work; ambiguous unqualified IDs are skipped', async () => {
  await go();
  await page.evaluate(() => {
    const aside = document.querySelector('aside');
    aside.innerHTML='<button data-app-action-sidebar-thread-id="local:same">Duplicate title</button><button data-app-action-sidebar-thread-id="ssh-host:same">Duplicate title</button><button data-thread-id="same">Duplicate title</button>';
    const now=Math.floor(Date.now()/1000);
    window.snapshot.catalogSnapshot.entries=[{id:'same',hostId:'local',recencyAt:now-3600},{id:'same',hostId:'ssh-host',recencyAt:now-7200}];
  });
  assert.equal((await install()).badges, 2);
  assert.deepEqual(await badges(), ['1h', '2h']);
  assert.equal(await page.locator('[data-thread-id="same"] [data-codex-mods-time]').count(), 0);
});

test('qualified and hosted adapter keys preserve nested title and action containers', async () => {
  await go();
  await page.evaluate(() => {
    const aside = document.querySelector('aside');
    const keys = ['local:local:same', 'local:remote-ssh-discovered:10.37.90.39:same', 'hosted:same'];
    aside.innerHTML = keys.map((key, index) => `<div role="button" tabindex="0" data-app-action-sidebar-thread-id="${key}" data-app-action-sidebar-thread-kind="${index === 2 ? 'cloud' : 'local'}" data-app-action-sidebar-thread-host-id="${index === 0 ? 'local' : index === 1 ? 'remote-ssh-discovered:10.37.90.39' : ''}"><div style="display:flex;width:100%"><div style="display:flex;flex:1;min-width:0"><div data-thread-title-trigger style="flex:1;min-width:0"><span data-thread-title>Native title ${index}</span></div><span class="status">○</span></div></div><div class="contents" data-hover-card-open-immediately><button aria-haspopup="menu">Actions</button></div></div>`).join('');
    const now = Math.floor(Date.now()/1000);
    window.snapshot = {catalogSnapshot:{entries:[
      {kind:'local',hostId:'local',thread:{id:'same',recencyAt:now-3600}},
      {kind:'local',hostId:'remote-ssh-discovered:10.37.90.39',thread:{id:'same',recencyAt:now-7200}},
      {kind:'cloud',task:{id:'same',recencyAt:now-10800}},
    ]}};
  });
  const state = await install({showSize:true,sessionSizes:{same:4096}});
  assert.equal(state.badges, 3);
  assert.equal(state.sizeBadges, 1);
  assert.deepEqual(await badges(), ['1h', '2h', '3h']);
  const local = page.locator('[data-app-action-sidebar-thread-id="local:local:same"]');
  assert.equal(await local.locator(':scope > [data-codex-mods-time], :scope > [data-codex-mods-size]').count(), 0);
  assert.equal(await local.locator('[data-thread-title-trigger]').textContent(), 'Native title 0');
  assert.equal(await local.locator('[data-codex-mods-size]').evaluate(node => node.parentElement === node.closest('[data-app-action-sidebar-thread-id]').querySelector('[data-thread-title-trigger]').parentElement), true);
  assert.equal(await local.locator('[data-codex-mods-size]').getAttribute('data-codex-mods-hover-actions'), '');
  await local.evaluate(node => node.setAttribute('data-app-action-sidebar-thread-host-id', 'other'));
  await waitFor(async () => await local.locator('[data-codex-mods-time], [data-codex-mods-size]').count() === 0, 'Conflicting native identity retained badges');
  await page.evaluate(cleanupExpression);
  assert.equal(await page.locator('[data-codex-mods-time], [data-codex-mods-size], [data-codex-mods-fill], .codex-mods-time-row').count(), 0);
  assert.equal(await page.locator('[data-thread-title-trigger]').count(), 3);
  assert.equal(await page.locator('[aria-haspopup="menu"]').count(), 3);
});

test('native sidebar separates the host attribute from local and remote task keys', async () => {
  await go();
  await page.evaluate(() => {
    document.querySelector('aside').innerHTML = '<button data-app-action-sidebar-thread-id="local:same" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-kind="local">Local</button><button data-app-action-sidebar-thread-id="local:same" data-app-action-sidebar-thread-host-id="remote-ssh-discovered:10.37.90.39" data-app-action-sidebar-thread-kind="local">SSH</button><button data-app-action-sidebar-thread-id="remote:same" data-app-action-sidebar-thread-host-id="" data-app-action-sidebar-thread-kind="remote">Cloud</button><button data-app-action-sidebar-thread-id="local:same" data-app-action-sidebar-thread-host-id="" data-app-action-sidebar-thread-kind="local">Unknown host</button>';
    const now = Math.floor(Date.now()/1000);
    window.snapshot={catalogSnapshot:{entries:[
      {kind:'local',hostId:'local',thread:{id:'same',recencyAt:now-3600}},
      {kind:'local',hostId:'remote-ssh-discovered:10.37.90.39',thread:{id:'same',recencyAt:now-7200}},
      {kind:'remote',task:{id:'same',recencyAt:now-10800}},
    ]}};
  });
  const state = await install({showSize:true,sessionSizes:{same:4096}});
  assert.equal(state.badges,3);
  assert.equal(state.sizeBadges,1);
  assert.deepEqual(await badges(),['1h','2h','3h']);
  const local=page.locator('[data-app-action-sidebar-thread-host-id="local"]');
  assert.equal(await local.locator('[data-codex-mods-size]').textContent(),'4.0 KiB');
  await local.evaluate(node=>node.setAttribute('data-app-action-sidebar-thread-host-id','remote-ssh-discovered:10.37.90.39'));
  await waitFor(async()=>await local.count()===0 && await page.locator('[data-codex-mods-size]').count()===0,'Host change retained a local disk size');
  assert.deepEqual(await badges(),['2h','2h','3h']);
});

test('unknown nested title layouts skip injection without altering the row', async () => {
  await go();
  await row('a').evaluate(row => {row.innerHTML = '<div style="display:block"><div data-thread-title-trigger>Unsupported layout</div></div>';});
  await install({showSize:true,sessionSizes:{a:4096}});
  assert.equal(await row('a').locator('[data-codex-mods-time], [data-codex-mods-size]').count(), 0);
  assert.equal(await row('a').getAttribute('data-codex-mods-fill'), null);
});

test('unknown native kinds cannot inherit a same-ID local session size or timestamp', async () => {
  await go();
  await page.evaluate(() => {
    document.querySelector('aside').innerHTML = '<button data-app-action-sidebar-thread-id="local:local:same" data-app-action-sidebar-thread-kind="local">Local</button><button data-app-action-sidebar-thread-id="local:local:same" data-app-action-sidebar-thread-kind="future-kind">Unknown</button><button data-thread-id="same">Legacy</button>';
    const now=Math.floor(Date.now()/1000);
    window.snapshot={catalogSnapshot:{entries:[
      {kind:'local',hostId:'local',task:{id:'same',recencyAt:now-3600}},
      {kind:'future-kind',hostId:'local',thread:{id:'same',recencyAt:now-7200}},
    ]}};
  });
  const state = await install({showSize:true,sessionSizes:{same:4096}});
  assert.equal(state.badges,1);
  assert.equal(state.sizeBadges,1);
  assert.deepEqual(await badges(),['1h']);
  assert.equal(await page.locator('[data-app-action-sidebar-thread-kind="future-kind"] [data-codex-mods-time], [data-app-action-sidebar-thread-kind="future-kind"] [data-codex-mods-size]').count(),0);
});

test('late bootstrap availability and DOM metadata are handled without guessing', async () => {
  await go();
  await page.evaluate(() => { delete window.electronBridge; document.querySelector('[data-app-action-sidebar-thread-id="local:a"]').setAttribute('data-updated-at', String(Math.floor(Date.now()/1000)-600)); });
  assert.equal((await install()).badges, 1);
  assert.deepEqual(await badges(), ['10m']);
  await page.evaluate(() => { window.electronBridge={getInitialSidebarBootstrap:()=>window.snapshot}; });
  await waitFor(async () => (await badges()).length === 3, 'Late bootstrap was not picked up');
});

test('reinstall and dispose leave no duplicate badges, classes or active observers', async () => {
  await go(); await install(); await install();
  assert.equal((await badges()).length, 3);
  assert.equal(await page.locator('[data-codex-mods-style]').count(), 1);
  await page.evaluate(cleanupExpression);
  assert.equal((await badges()).length, 0);
  assert.equal(await page.locator('.codex-mods-time-row, [data-codex-mods-style]').count(), 0);
  await page.evaluate(() => document.querySelector('aside').append(document.createElement('button')));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await badges()).length, 0);
});

test('compact viewport keeps time and status controls within each row', async () => {
  await page.setViewportSize({ width: 390, height: 650 });
  await go(); await install();
  for (const id of ['a', 'b', 'c']) {
    const parent = await row(id).boundingBox();
    const badge = await row(id).locator('[data-codex-mods-time]').boundingBox();
    const status = await row(id).locator('.status').boundingBox();
    assert.ok(badge.x >= parent.x && badge.x+badge.width <= parent.x+parent.width);
    assert.ok(badge.x+badge.width < status.x);
    assert.ok(status.x+status.width <= parent.x+parent.width);
  }
  await row('a').click();
  assert.equal(await page.locator('#clicked').textContent(), 'Investigate task generation');
  await page.screenshot({ path: join(tmpdir(), 'codex-mods-sidebar-compact.png') });
  await page.setViewportSize({ width: 1100, height: 650 });
});

test('real CLI + CDP reinject on reload and disable removes future registrations', async () => {
  await go();
  const directory = await mkdtemp(join(tmpdir(), 'codex-mods-e2e-'));
  const cli = cliPath;
  const environment = { ...process.env, CODEX_MODS_STATE_DIR: directory };
  const child = spawn(process.execPath, [cli, 'enable', 'sidebar-time', '--endpoint', endpoint, '--no-launch', '--fixture', '--refresh-ms', '1000'], { env: environment });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(async () => (await badges()).length === 3, 'CLI failed to inject: ' + output);
    assert.ok(output.includes('Watching Codex'));
    // Suspending the watcher proves that its registered script, not a polling retry,
    // restores the labels. SIGSTOP is unavailable on Windows.
    if (process.platform !== 'win32') child.kill('SIGSTOP');
    try {
      await page.reload();
      await waitFor(async () => (await badges()).length === 3, 'Reload did not reinject through the registered Page script');
    } finally { if (process.platform !== 'win32') child.kill('SIGCONT'); }
    const target = (await targets(endpoint, true)).find(target => target.url === origin + '/');
    const client = await CDP.connect(target, endpoint);
    try { assert.equal((await client.evaluate('globalThis.__codexModsSidebarTime.status()')).badges, 3); }
    finally { client.close(); }
    const disableChild = spawn(process.execPath, [cli, 'disable', 'sidebar-time'], { env: environment });
    let disableOutput=''; disableChild.stdout.on('data', data => { disableOutput += data; }); disableChild.stderr.on('data', data => { disableOutput += data; });
    const code = await new Promise(resolve => disableChild.once('exit', resolve));
    assert.equal(code, 0, disableOutput);
    assert.equal(JSON.parse(disableOutput).cleanupConfirmed, true);
    const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Watcher did not stop')), 10000))]);
    assert.equal(result.code, 0, output);
    assert.ok(!output.includes('Cleanup not confirmed'), output);
    await page.reload();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await badges()).length, 0);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('real CLI refreshes disk sizes on file growth, reload, and deletion', async () => {
  await go();
  const directory = await mkdtemp(join(tmpdir(), 'codex-mods-size-e2e-'));
  const home = join(directory, 'codex');
  const sessionId = '01234567-89ab-cdef-0123-456789abcdef';
  await mkdir(join(home, 'sessions'), {recursive:true});
  const record = join(home,'sessions',`rollout-2026-10-09T00-00-${sessionId}.jsonl`);
  await writeFile(record, 'x'.repeat(2048));
  const setIdentity = () => row('a').evaluate((row,id) => row.setAttribute('data-app-action-sidebar-thread-id',`local:${id}`),sessionId);
  await setIdentity();
  const environment = {...process.env,CODEX_MODS_STATE_DIR:join(directory,'state')};
  const child = spawn(process.execPath,[cliPath,'enable','sidebar-size','--codex-home',home,'--endpoint',endpoint,'--no-launch','--fixture','--refresh-ms','1000'],{env:environment});
  let output = '';
  child.stdout.on('data',data => {output += data;}); child.stderr.on('data',data => {output += data;});
  const exited = new Promise(resolve => child.once('exit',code => resolve(code)));
  const size = () => row(sessionId).locator('[data-codex-mods-size]').textContent();
  try {
    await waitFor(async () => (await page.locator('[data-codex-mods-size]').count()) === 1,'Size CLI did not inject: '+output);
    assert.equal(await size(),'2.0 KiB');
    assert.equal(await page.locator('[data-codex-mods-time]').count(),0);
    await writeFile(record,'x'.repeat(4096));
    await waitFor(async () => (await size()) === '4.0 KiB','File growth did not refresh');
    await page.reload(); await setIdentity();
    await waitFor(async () => (await size()) === '4.0 KiB','Reload restored stale size data');
    await rm(record);
    await waitFor(async () => (await page.locator('[data-codex-mods-size]').count()) === 0,'Deleted record kept a stale size');
    const clean = spawn(process.execPath,[cliPath,'disable','sidebar-size'],{env:environment});
    let cleanOutput=''; clean.stdout.on('data',data=>{cleanOutput+=data;}); clean.stderr.on('data',data=>{cleanOutput+=data;});
    assert.equal(await new Promise(resolve=>clean.once('exit',resolve)),0,cleanOutput);
    assert.equal(await exited,0,output);
    assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill], [data-codex-mods-style]').count(),0);
  } finally {
    if(child.exitCode === null && child.signalCode === null){child.kill('SIGTERM');await exited;}
    await rm(directory,{recursive:true,force:true});
  }
});

test('a crashed watcher can be cleaned up without leaving reload injection behind', async () => {
  await go();
  const directory = await mkdtemp(join(tmpdir(), 'codex-mods-crash-'));
  const cli = cliPath;
  const environment = { ...process.env, CODEX_MODS_STATE_DIR: directory };
  const child = spawn(process.execPath, [cli, 'enable', 'sidebar-time', '--endpoint', endpoint, '--no-launch', '--fixture'], { env: environment });
  child.stdout.resume(); child.stderr.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await waitFor(async () => (await badges()).length === 3, 'Crash test failed to inject');
    child.kill('SIGKILL'); await exited;
    assert.equal((await badges()).length, 3, 'Existing DOM should remain until cleanup or reload');
    const clean = spawn(process.execPath, [cli, 'disable', 'sidebar-time'], { env: environment });
    let output=''; clean.stdout.on('data', data => { output+=data; }); clean.stderr.on('data', data => { output+=data; });
    assert.equal(await new Promise(resolve => clean.once('exit', resolve)), 0, output);
    assert.equal(JSON.parse(output).cleanupConfirmed, true);
    await page.reload();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await badges()).length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser console and page have no runtime errors', () => assert.deepEqual(errors, []));
