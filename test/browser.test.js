import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, appendFile, open as openFile, rm } from 'node:fs/promises';
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

test('session sizes render proportional full-height fills in light and dark rows', async () => {
  await go();
  const sizes = { a: Math.round(7.6 * 1024 ** 2), b: Math.round(9.8 * 1024 ** 2), c: 33 * 1024 ** 2, d: 119 * 1024 ** 2, e: 0, f: 1024 ** 3, g: 2 * 1024 ** 3 };
  await page.evaluate(() => {
    const aside = document.querySelector('aside');
    for (const id of ['d', 'e', 'f', 'g']) {
      const extra = document.querySelector('[data-app-action-sidebar-thread-id="local:c"]').cloneNode(true);
      extra.setAttribute('data-app-action-sidebar-thread-id', `local:${id}`);
      extra.querySelector('.title').textContent = `Session ${id}`;
      aside.append(extra);
    }
    const now = Math.floor(Date.now() / 1000);
    window.snapshot.catalogSnapshot.entries.push(...['d', 'f', 'g'].map((id, index) => ({ id, recencyAt: now - (240 + index * 60) })));
  });
  const state = await install({ showSize: true, sessionSizes: sizes });
  assert.equal(state.badges, 6);
  assert.equal(state.sizeBadges, 7);
  assert.deepEqual(await page.locator('[data-codex-mods-size]').allTextContents(), ['7.6 MiB', '9.8 MiB', '33 MiB', '119 MiB', '0 B', '1.0 GiB', '2.0 GiB']);
  const fills = await page.locator('[data-codex-mods-fill]').evaluateAll(rows => rows.map(row => parseFloat(row.style.getPropertyValue('--codex-mods-fill'))));
  assert.ok(fills[0] < fills[1] && fills[1] < fills[2] && fills[2] < fills[3]);
  assert.equal(fills[4], 0);
  assert.equal(fills[5], 100);
  assert.equal(fills[6], 100);
  const renderedFillLengths = await page.locator('[data-codex-mods-fill]').evaluateAll(rows => rows.map(node => {
    const width = node.getBoundingClientRect().width;
    const [layerWidth, layerHeight] = getComputedStyle(node).backgroundSize.trim().split(/\s+/);
    const background = getComputedStyle(node).backgroundImage;
    return { pixels: width * parseFloat(layerWidth) / 100, layerWidth, layerHeight, background, layers: getComputedStyle(node).backgroundSize.split(',').length };
  }));
  assert.ok(renderedFillLengths[3].pixels / renderedFillLengths[1].pixels > 3, `119 MiB / 9.8 MiB fill ratio was ${renderedFillLengths[3].pixels / renderedFillLengths[1].pixels}`);
  for (const fill of renderedFillLengths) {
    assert.equal(fill.layers, 1, `expected one full-height fill layer, got ${fill.layers}: ${fill.background}`);
    assert.equal(fill.layerHeight, '100%', `expected a full-height fill, got ${fill.layerHeight}`);
  }
  assert.equal(await row('a').locator('[data-codex-mods-time]').count(), 1, 'time and size badges should coexist');
  await row('a').evaluate(node => { node.style.backgroundColor = 'rgb(1, 2, 3)'; });
  assert.match(await row('a').locator('[data-codex-mods-size]').getAttribute('title'), /7,969,178/);
  await row('b').locator('[data-codex-mods-size]').click();
  assert.equal(await page.locator('#clicked').textContent(), 'Review workflow safeguards');
  for (const width of [1100, 390]) {
    await page.setViewportSize({width, height: 650});
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const parent = await row(id).boundingBox();
      const size = await row(id).locator('[data-codex-mods-size]').boundingBox();
      const status = await row(id).locator('.status').boundingBox();
      assert.ok(size.x >= parent.x && size.x + size.width < status.x);
      assert.ok(status.x + status.width <= parent.x + parent.width);
    }
  }
  await page.mouse.move(380,300);
  await page.locator('aside').screenshot({path: join(tmpdir(), 'codex-mods-size-light.png')});
  const lightRail = await row('a').evaluate(node => ({
    backgroundColor: getComputedStyle(node).backgroundColor,
    backgroundImage: getComputedStyle(node).backgroundImage,
    backgroundSize: getComputedStyle(node).backgroundSize,
  }));
  assert.equal(lightRail.backgroundColor, 'rgb(1, 2, 3)');
  assert.equal(lightRail.backgroundSize.split(',').length, 1, `expected one full-height fill layer, got ${lightRail.backgroundSize}`);
  assert.equal(lightRail.backgroundSize.trim().split(/\s+/)[1], '100%', `fill should span row height, got ${lightRail.backgroundSize}`);
  await page.addStyleTag({content:'body{background:#202123;color:#dedee2}aside{border-color:#393a3c}button:hover{background:#303134}'});
  await page.locator('aside').screenshot({path: join(tmpdir(), 'codex-mods-size-dark.png')});
  const darkRail = await row('a').evaluate(node => ({
    backgroundColor: getComputedStyle(node).backgroundColor,
    backgroundImage: getComputedStyle(node).backgroundImage,
    backgroundSize: getComputedStyle(node).backgroundSize,
  }));
  assert.equal(darkRail.backgroundColor, 'rgb(1, 2, 3)');
  assert.equal(darkRail.backgroundSize.split(',').length, 1);
  assert.equal(darkRail.backgroundSize.trim().split(/\s+/)[1], '100%');
  assert.notEqual(darkRail.backgroundImage, lightRail.backgroundImage, 'the rail should follow currentColor in dark mode');
  await page.setViewportSize({width:1100,height:650});
  await page.evaluate(cleanupExpression);
  assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-time], [data-codex-mods-fill], [data-codex-mods-style], .codex-mods-time-row').count(), 0);
  assert.equal(await row('a').evaluate(row => row.style.getPropertyValue('--codex-mods-fill')), '');
  assert.equal(await row('a').evaluate(row => row.style.backgroundColor), 'rgb(1, 2, 3)');
  assert.equal(await row('a').evaluate(row => row.style.backgroundImage), '');
  assert.equal(await row('a').locator('.title').textContent(), 'Investigate task generation');
  assert.equal(await row('a').locator('.status').textContent(), '○');
});

test('flat catalog source timestamps match local and SSH rows without leaking between hosts', async () => {
  await go();
  await page.evaluate(() => {
    const now = Math.floor(Date.now() / 1000);
    document.querySelector('aside').innerHTML = [
      '<button data-app-action-sidebar-thread-id="local:shared" data-app-action-sidebar-thread-host-id="local">Local copy</button>',
      '<button data-app-action-sidebar-thread-id="local:shared" data-app-action-sidebar-thread-host-id="ssh-host">SSH copy</button>',
      '<button data-app-action-sidebar-thread-id="local:unknown" data-app-action-sidebar-thread-host-id="local">Unknown timestamp</button>',
    ].join('');
    window.snapshot = { catalogEntries: [
      { threadId: 'shared', hostId: 'local', sourceRecencyAt: now - 5 * 60, sourceUpdatedAt: now - 95 * 60, sourceCreatedAt: now - 2 * 86400 },
      // No recency value: recency mode must fall back to the source update time.
      { threadId: 'shared', hostId: 'ssh-host', sourceUpdatedAt: now - 11 * 60, sourceCreatedAt: now - 3 * 86400 },
    ] };
  });

  assert.equal((await install()).badges, 2);
  assert.deepEqual(await badges(), ['5m', '11m']);
  assert.equal(await page.locator('[data-app-action-sidebar-thread-id="local:unknown"] [data-codex-mods-time]').count(), 0);

  await page.evaluate(payload({ timeField: 'updated', refreshMs: 1000 }));
  assert.deepEqual(await badges(), ['1h', '11m']);
  await page.evaluate(payload({ timeField: 'created', refreshMs: 1000 }));
  assert.deepEqual(await badges(), ['2d', '3d']);
  assert.equal(await page.locator('[data-app-action-sidebar-thread-id="local:unknown"] [data-codex-mods-time]').count(), 0);
});

test('archive policy thresholds, localized copy, and hover behavior preserve native geometry', async () => {
  await go();
  await page.evaluate(() => {
    const now = Date.now();
    const row = (id, title, withHoverActions = true) => `<div role="button" tabindex="0" class="native-row" data-app-action-sidebar-thread-id="local:${id}" data-app-action-sidebar-thread-host-id="local" style="position:static;display:flex;align-items:center;box-sizing:border-box;width:340px;height:44px;padding:0 8px 0 32px;gap:8px;color:#65617c">
      <div class="title-group" style="display:flex;flex:1;min-width:0;align-items:center;gap:8px"><span class="title" data-thread-title-trigger style="flex:1;min-width:0">${title}</span><button class="active-control" type="button" aria-label="Active" style="width:20px;height:20px;margin:0;padding:0;flex:0 0 20px">✓</button></div>
      ${withHoverActions ? `<div class="hover-controls" data-hover-card-open-immediately><button class="hover-control" type="button" aria-label="${id === 'aged' ? 'Archive chat' : 'Actions'}" style="width:20px;height:20px;margin:0;padding:0;flex:0 0 20px">⋯</button></div>` : ''}
    </div>`;
    document.querySelector('aside').innerHTML = [
      row('aged', 'Old session'),
      row('threshold', 'At threshold'),
      row('recent', 'Recent message'),
      row('future', 'Future timestamp'),
      row('unknown', 'No activity record'),
      row('aged', 'SSH copy'),
      row('large25', 'Large at 25 hours'),
      row('large24', 'Large at exactly 24 hours'),
      row('small25', 'Small at 25 hours'),
      row('large23', 'Large at 23 hours'),
      row('oldinvalidsize', 'Old with invalid size'),
      row('largeunknown', 'Large with unknown activity'),
      row('largefuture', 'Large with future activity'),
      row('largeremote', 'Large remote session'),
      row('sizerefresh', 'Size refresh threshold'),
      row('noactions', 'Old row without hover actions', false),
      row('oldsmall', 'Old small session'),
      row('exactsizeold', 'Old session at exact size threshold'),
      row('exact48large', 'Large session at exact 48 hours'),
      row('oldnegative', 'Old session with negative size'),
      row('oldmissing', 'Old session with missing size'),
      row('busystatus', 'Working with status spinner'),
      row('busyaria', 'Working with busy state'),
      row('activefalse', 'Inactive selection candidate'),
      row('selectedfalse', 'Unselected candidate'),
    ].join('');
    const rows = document.querySelectorAll('.native-row');
    rows[5].setAttribute('data-app-action-sidebar-thread-host-id', 'ssh-host');
    rows[13].setAttribute('data-app-action-sidebar-thread-host-id', 'ssh-host');
    document.querySelector('.native-row[data-app-action-sidebar-thread-id="local:busyaria"]').setAttribute('aria-busy', 'true');
    document.querySelector('.native-row[data-app-action-sidebar-thread-id="local:activefalse"]').setAttribute('data-active', 'false');
    document.querySelector('.native-row[data-app-action-sidebar-thread-id="local:selectedfalse"]').setAttribute('aria-selected', 'false');
    const spinner = document.createElement('span');
    spinner.className = 'working-spinner';
    spinner.setAttribute('role', 'status');
    spinner.setAttribute('aria-label', 'Working');
    spinner.textContent = '⟳';
    Object.assign(spinner.style, { position: 'absolute', right: '22px', width: '12px', height: '12px', pointerEvents: 'none' });
    document.querySelector('.native-row[data-app-action-sidebar-thread-id="local:busystatus"] .title-group').append(spinner);
    window.nativeControlClicks = 0;
    window.chatSelections = 0;
    window.archiveActions = 0;
    rows.forEach(row => {
      row.addEventListener('click', () => window.chatSelections++);
    });
    document.querySelectorAll('.active-control, .hover-control').forEach(control => control.addEventListener('click', event => {
      event.stopPropagation();
      window.nativeControlClicks++;
      if (control.getAttribute('aria-label') === 'Archive chat') window.archiveActions++;
    }));
    window.snapshot = { catalogSnapshot: { entries: [
      { id: 'aged', hostId: 'local' },
      { id: 'aged', hostId: 'ssh-host' },
      { id: 'threshold', hostId: 'local' },
      { id: 'recent', hostId: 'local' },
      { id: 'future', hostId: 'local' },
      { id: 'unknown', hostId: 'local' },
      ...['large25', 'large24', 'small25', 'large23', 'oldinvalidsize', 'largeunknown', 'largefuture', 'sizerefresh', 'noactions', 'oldsmall', 'exactsizeold', 'exact48large', 'oldnegative', 'oldmissing', 'busystatus', 'busyaria', 'activefalse', 'selectedfalse'].map(id => ({ id, hostId: 'local' })),
      { id: 'largeremote', hostId: 'ssh-host' },
    ] } };
    window.__fixedNow = now;
    Date.now = () => window.__fixedNow;
  });
  const nativeRow = id => page.locator(`.native-row[data-app-action-sidebar-thread-id="local:${id}"]`);
  const agedRows = page.locator('.native-row[data-app-action-sidebar-thread-id="local:aged"]');
  const aged = agedRows.first();
  const sshCopy = agedRows.nth(1);
  const threshold = nativeRow('threshold');
  const recent = nativeRow('recent');
  const future = nativeRow('future');
  const unknown = nativeRow('unknown');
  const large25 = nativeRow('large25');
  const large24 = nativeRow('large24');
  const small25 = nativeRow('small25');
  const large23 = nativeRow('large23');
  const oldinvalidsize = nativeRow('oldinvalidsize');
  const largeunknown = nativeRow('largeunknown');
  const largefuture = nativeRow('largefuture');
  const largeremote = page.locator('.native-row[data-app-action-sidebar-thread-id="local:largeremote"]');
  const sizerefresh = nativeRow('sizerefresh');
  const noactions = nativeRow('noactions');
  const oldsmall = nativeRow('oldsmall');
  const exactsizeold = nativeRow('exactsizeold');
  const exact48large = nativeRow('exact48large');
  const oldnegative = nativeRow('oldnegative');
  const oldmissing = nativeRow('oldmissing');
  const busystatus = nativeRow('busystatus');
  const busyaria = nativeRow('busyaria');
  const activefalse = nativeRow('activefalse');
  const selectedfalse = nativeRow('selectedfalse');
  const rows = [aged, threshold, recent, future, unknown, sshCopy, large25, large24, small25, large23, oldinvalidsize, largeunknown, largefuture, largeremote, sizerefresh, noactions, oldsmall, exactsizeold, exact48large, oldnegative, oldmissing, busystatus, busyaria, activefalse, selectedfalse];
  const initialGeometry = await Promise.all(rows.map(row => row.evaluate(node => {
    const title = node.querySelector('[data-thread-title-trigger]').getBoundingClientRect();
    const rect = element => { const target = node.querySelector(element); if (!target) return null; const value = target.getBoundingClientRect(); return [value.x, value.y, value.width, value.height]; };
    return { title: [title.x, title.y], active: rect('.active-control'), hover: rect('.hover-control') };
  })));

  const now = await page.evaluate(() => window.__fixedNow);
  const lastMessages = {
    aged: now - 49 * 60 * 60 * 1000,
    threshold: now - 48 * 60 * 60 * 1000,
    recent: now - 47 * 60 * 60 * 1000,
    future: now + 60 * 60 * 1000,
    large25: now - 25 * 60 * 60 * 1000,
    large24: now - 24 * 60 * 60 * 1000,
    small25: now - 25 * 60 * 60 * 1000,
    large23: now - 47 * 60 * 60 * 1000,
    oldinvalidsize: now - 49 * 60 * 60 * 1000,
    largefuture: now + 60 * 60 * 1000,
    largeremote: now - 25 * 60 * 60 * 1000,
    sizerefresh: now - 49 * 60 * 60 * 1000,
    noactions: now - 49 * 60 * 60 * 1000,
    oldsmall: now - 49 * 60 * 60 * 1000,
    exactsizeold: now - 49 * 60 * 60 * 1000,
    exact48large: now - 48 * 60 * 60 * 1000,
    oldnegative: now - 49 * 60 * 60 * 1000,
    oldmissing: now - 49 * 60 * 60 * 1000,
    busystatus: now - 49 * 60 * 60 * 1000,
    busyaria: now - 49 * 60 * 60 * 1000,
    activefalse: now - 49 * 60 * 60 * 1000,
    selectedfalse: now - 49 * 60 * 60 * 1000,
  };
  const sessionSizes = { aged: 119 * 1024 ** 2, threshold: 24 * 1024 ** 2, recent: 1 * 1024 ** 2, future: 2 * 1024 ** 2, unknown: 128 * 1024 ** 2, large25: 100 * 1024 ** 2, large24: 100 * 1024 ** 2, small25: 99 * 1024 ** 2, large23: 120 * 1024 ** 2, oldinvalidsize: 'invalid', largeunknown: 120 * 1024 ** 2, largefuture: 120 * 1024 ** 2, largeremote: 120 * 1024 ** 2, sizerefresh: 100_000_000, noactions: 119 * 1024 ** 2, oldsmall: 99_999_999, exactsizeold: 100_000_000, exact48large: 100_000_001, oldnegative: -1, busystatus: 119 * 1024 ** 2, busyaria: 119 * 1024 ** 2, activefalse: 119 * 1024 ** 2, selectedfalse: 119 * 1024 ** 2 };
  await install({ locale: 'en-US', showTime: false, showLegacy: true, showSize: true, lastMessages, sessionSizes });
  const combinedGeometry = await Promise.all(rows.map(row => row.evaluate(node => {
    const title = node.querySelector('[data-thread-title-trigger]').getBoundingClientRect();
    const rect = element => { const target = node.querySelector(element); if (!target) return null; const value = target.getBoundingClientRect(); return [value.x, value.y, value.width, value.height]; };
    return { title: [title.x, title.y], active: rect('.active-control'), hover: rect('.hover-control') };
  })));
  assert.deepEqual(combinedGeometry, initialGeometry, 'archive recommendation and size must preserve title and control geometry');
  const recommendation = aged.locator('[data-codex-mods-legacy]');
  assert.equal(await recommendation.textContent(), 'Archive suggestion');
  assert.equal(await recommendation.getAttribute('role'), null, 'recommendation is informational, not an interactive control');
  assert.equal(await recommendation.getAttribute('tabindex'), null);
  assert.equal(await recommendation.getAttribute('aria-haspopup'), null);
  const englishHelp = await recommendation.getAttribute('title');
  assert.match(englishHelp, /Session records exceed 100 MB \(119 MiB\), with no new messages for over 48 hours/);
  assert.match(englishHelp, /history stays saved and can be restored/);
  assert.match(englishHelp, /does not free disk space/);
  assert.match(englishHelp, /Last message:/);
  assert.match(englishHelp, /Hover the chat, then use its Archive button on the right\./);
  assert.equal(await recommendation.getAttribute('aria-label'), `Archive suggestion. ${englishHelp}`);
  assert.equal(await aged.locator('[data-codex-mods-size]').textContent(), '119 MiB');
  assert.equal(await recommendation.getAttribute('data-codex-mods-archive-reason'), 'size');
  assert.equal(await aged.locator('[data-codex-mods-size]').evaluate(node => getComputedStyle(node, '::before').content), '"· "');
  const markedRows = await page.locator('[data-codex-mods-legacy]').evaluateAll(nodes => nodes.map(node => [node.closest('.native-row')?.getAttribute('data-app-action-sidebar-thread-id'), node.getAttribute('data-codex-mods-archive-reason')]));
  assert.equal(markedRows.length, 4, `only eligible idle rows without a working indicator should be marked: ${JSON.stringify(markedRows)}`);
  assert.equal(await threshold.locator('[data-codex-mods-legacy]').count(), 0, 'exactly 48 hours is not legacy');
  assert.equal(await recent.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await future.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await unknown.locator('[data-codex-mods-legacy]').count(), 0, 'large size alone without a last-message record must not qualify');
  assert.equal(await sshCopy.locator('[data-codex-mods-legacy], [data-codex-mods-size]').count(), 0, 'local activity and size must not leak to the SSH row');
  assert.equal(await large25.locator('[data-codex-mods-legacy]').count(), 0, '100 MiB and 25 hours do not exceed both strict thresholds');
  assert.equal(await large24.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await small25.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await large23.locator('[data-codex-mods-legacy]').count(), 0, 'large size cannot qualify before 48 hours');
  assert.equal(await oldinvalidsize.locator('[data-codex-mods-legacy]').count(), 0, 'invalid size does not qualify even after 48 hours');
  assert.equal(await oldinvalidsize.locator('[data-codex-mods-size]').count(), 0, 'invalid size must not render a size badge');
  assert.equal(await largeunknown.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await largefuture.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await largeremote.locator('[data-codex-mods-legacy], [data-codex-mods-size]').count(), 0, 'large remote sessions must never be marked');
  assert.equal(await sizerefresh.locator('[data-codex-mods-legacy]').count(), 0, 'exactly 100,000,000 bytes does not exceed the strict size threshold');
  assert.equal(await noactions.locator('[data-codex-mods-legacy]').count(), 1);
  assert.equal(await oldsmall.locator('[data-codex-mods-legacy]').count(), 0, 'old small sessions do not qualify');
  assert.equal(await exactsizeold.locator('[data-codex-mods-legacy]').count(), 0, 'an old session at exactly 100,000,000 bytes does not qualify');
  assert.equal(await exact48large.locator('[data-codex-mods-legacy]').count(), 0, 'a large session at exactly 48 hours does not qualify');
  assert.equal(await oldnegative.locator('[data-codex-mods-legacy]').count(), 0, 'negative size does not qualify even after 48 hours');
  assert.equal(await oldmissing.locator('[data-codex-mods-legacy]').count(), 0, 'missing size does not qualify even after 48 hours');
  for (const busyRow of [busystatus, busyaria]) {
    assert.equal(await busyRow.locator('[data-codex-mods-legacy]').count(), 0, 'working state suppresses an otherwise eligible recommendation');
    assert.equal(await busyRow.locator('[data-codex-mods-size]').textContent(), '119 MiB', 'working state must not suppress session size');
    assert.equal(await busyRow.evaluate(row => row.hasAttribute('data-codex-mods-fill')), true, 'working state must preserve the native row fill');
    assert.notEqual(await busyRow.evaluate(row => getComputedStyle(row).backgroundImage), 'none', 'working state must preserve the size fill background');
  }
  assert.equal(await activefalse.locator('[data-codex-mods-legacy]').count(), 1, 'data-active=false is not a working indicator');
  assert.equal(await selectedfalse.locator('[data-codex-mods-legacy]').count(), 1, 'aria-selected=false is not a working indicator');
  for (const row of [aged, threshold, recent, future, unknown, large25, large24, small25, large23, oldinvalidsize, largeunknown, largefuture, sizerefresh, noactions, oldsmall, exactsizeold, exact48large, oldnegative, oldmissing, busystatus, busyaria, activefalse, selectedfalse]) {
    const titleBox = await row.locator('[data-thread-title-trigger]').boundingBox();
    const sizeBadge = row.locator('[data-codex-mods-size]');
    if (await sizeBadge.count()) {
      const sizeBox = await sizeBadge.boundingBox();
      assert.ok(sizeBox.x > titleBox.x + titleBox.width, 'size should stay to the right of the title');
    }
  }
  const agedTitle = await aged.locator('[data-thread-title-trigger]').boundingBox();
  const legacyBox = await aged.locator('[data-codex-mods-legacy]').boundingBox();
  const agedSize = await aged.locator('[data-codex-mods-size]').boundingBox();
  assert.ok(legacyBox.x > agedTitle.x + agedTitle.width, 'recommendation should sit to the right of the title');
  assert.ok(legacyBox.x + legacyBox.width <= agedSize.x, 'recommendation should precede the size label');

  await aged.hover();
  assert.equal(await recommendation.evaluate(node => getComputedStyle(node).visibility), 'hidden', 'the recommendation hides on row hover to reveal the native Archive action');
  assert.equal(await aged.locator('[data-codex-mods-size]').evaluate(node => getComputedStyle(node).visibility), 'hidden');
  await noactions.hover();
  assert.equal(await noactions.locator('[data-codex-mods-legacy]').evaluate(node => getComputedStyle(node).visibility), 'hidden');
  assert.equal(await noactions.locator('[data-codex-mods-size]').evaluate(node => getComputedStyle(node).visibility), 'visible', 'size remains visible when no native hover action can replace it');
  assert.equal(await noactions.locator('[data-codex-mods-size]').evaluate(node => getComputedStyle(node, '::before').visibility), 'hidden', 'hidden recommendation must not leave an orphan separator');
  await page.mouse.move(900, 600);
  assert.equal(await recommendation.evaluate(node => getComputedStyle(node).visibility), 'visible');
  assert.equal(await aged.locator('[data-codex-mods-size]').evaluate(node => getComputedStyle(node).visibility), 'visible');
  await aged.locator('.active-control').focus();
  assert.equal(await recommendation.evaluate(node => getComputedStyle(node).visibility), 'hidden', 'focus-within also hides the recommendation');
  await page.locator('body').click({ position: { x: 900, y: 600 } });
  assert.equal(await recommendation.evaluate(node => getComputedStyle(node).visibility), 'visible', 'recommendation returns after focus leaves');
  await aged.locator('.hover-controls').evaluate(node => node.setAttribute('aria-expanded', 'true'));
  assert.equal(await recommendation.evaluate(node => getComputedStyle(node).visibility), 'hidden', 'an expanded native action menu hides the recommendation');
  await aged.locator('.hover-controls').evaluate(node => node.removeAttribute('aria-expanded'));
  assert.equal(await recommendation.evaluate(node => getComputedStyle(node).visibility), 'visible');

  await page.evaluate(() => { window.__fixtureRenderer = globalThis.__codexModsSidebarTime; });
  await busystatus.evaluate(row => {
    const spinner = row.querySelector('[role="status"]');
    window.__fixtureWorkingSpinner = spinner;
    spinner.remove();
  });
  await waitFor(async () => await busystatus.locator('[data-codex-mods-legacy]').count() === 1, 'removing the working spinner should allow the eligible recommendation');
  assert.equal(await busystatus.locator('[data-codex-mods-size]').textContent(), '119 MiB');
  await busystatus.evaluate(row => row.querySelector('.title-group').append(window.__fixtureWorkingSpinner));
  await waitFor(async () => await busystatus.locator('[data-codex-mods-legacy]').count() === 0, 'inserting the working spinner should suppress the recommendation');
  await busystatus.evaluate(row => row.querySelector('[role="status"]').setAttribute('role', 'presentation'));
  await waitFor(async () => await busystatus.locator('[data-codex-mods-legacy]').count() === 1, 'changing role=status to a non-status role should restore the recommendation');
  await busystatus.evaluate(row => row.querySelector('[role="presentation"]').setAttribute('role', 'status'));
  await waitFor(async () => await busystatus.locator('[data-codex-mods-legacy]').count() === 0, 'restoring role=status should suppress the recommendation');

  await busyaria.evaluate(row => row.setAttribute('aria-busy', 'false'));
  await waitFor(async () => await busyaria.locator('[data-codex-mods-legacy]').count() === 1, 'aria-busy=false should allow the eligible recommendation');
  await busyaria.evaluate(row => row.setAttribute('aria-busy', 'true'));
  await waitFor(async () => await busyaria.locator('[data-codex-mods-legacy]').count() === 0, 'aria-busy=true should suppress the recommendation');
  assert.equal(await page.evaluate(() => globalThis.__codexModsSidebarTime === window.__fixtureRenderer), true, 'busy-state transitions must not reinject the renderer');
  const busyGeometryAfter = await Promise.all([busystatus, busyaria].map(row => row.evaluate(node => {
    const title = node.querySelector('[data-thread-title-trigger]').getBoundingClientRect();
    const rect = selector => { const value = node.querySelector(selector).getBoundingClientRect(); return [value.x, value.y, value.width, value.height]; };
    return { title: [title.x, title.y], active: rect('.active-control'), hover: rect('.hover-control') };
  })));
  assert.deepEqual(busyGeometryAfter, [initialGeometry[21], initialGeometry[22]], 'busy transitions must preserve title and control geometry');
  for (const busyRow of [busystatus, busyaria]) {
    assert.equal(await busyRow.locator('[data-codex-mods-size]').textContent(), '119 MiB');
    assert.equal(await busyRow.evaluate(row => row.hasAttribute('data-codex-mods-fill')), true);
  }

  assert.equal(await page.evaluate(() => window.chatSelections), 0);
  assert.equal(await page.evaluate(() => window.archiveActions), 0, 'rendering or hovering the recommendation must not archive automatically');

  await page.setViewportSize({ width: 390, height: 650 });
  const compactRow = await aged.boundingBox();
  const compactTitle = await aged.locator('[data-thread-title-trigger]').boundingBox();
  const compactRecommendation = await recommendation.boundingBox();
  const compactSize = await aged.locator('[data-codex-mods-size]').boundingBox();
  const compactControls = await Promise.all([aged.locator('.active-control'), aged.locator('.hover-control')].map(control => control.boundingBox()));
  assert.equal(compactTitle.x, initialGeometry[0].title[0]);
  assert.ok(compactRecommendation.x > compactTitle.x + compactTitle.width);
  assert.ok(compactRecommendation.x + compactRecommendation.width <= compactSize.x);
  assert.ok(compactSize.x + compactSize.width <= compactRow.x + compactRow.width);
  for (const control of compactControls) assert.ok(control.x + control.width <= compactRow.x + compactRow.width, 'compact English copy must not push native controls outside the row');

  await page.evaluate(() => globalThis.__codexModsSidebarTime.setSessionSizes({ sizerefresh: 100_000_001 }, null, 9));
  assert.equal(await sizerefresh.locator('[data-codex-mods-legacy]').count(), 1, 'crossing 100,000,000 bytes updates qualification without reinjection');
  assert.equal(await sizerefresh.locator('[data-codex-mods-legacy]').getAttribute('data-codex-mods-archive-reason'), 'size');
  await page.evaluate(() => globalThis.__codexModsSidebarTime.setSessionSizes({ sizerefresh: 100_000_000 }, null, 10));
  assert.equal(await sizerefresh.locator('[data-codex-mods-legacy]').count(), 0, 'returning to exactly 100,000,000 bytes clears size-based eligibility');

  await page.evaluate(cleanupExpression);
  await page.evaluate(payload({ locale: 'zh-CN', showTime: false, showLegacy: true, showSize: true, lastMessages, sessionSizes }));
  assert.equal(await recommendation.textContent(), '建议归档');
  const chineseHelp = await recommendation.getAttribute('title');
  assert.match(chineseHelp, /记录超过 100 MB（当前 119 MiB），且超过 48 小时没有新消息/);
  assert.match(chineseHelp, /记录保留，之后可恢复/);
  assert.match(chineseHelp, /不会释放磁盘空间/);
  assert.match(chineseHelp, /最后一条消息[:：]/);
  assert.match(chineseHelp, /悬停会话，点击右侧“Archive chat”按钮归档。/);
  assert.equal(await recommendation.getAttribute('aria-label'), `建议归档。${chineseHelp}`);
  assert.equal(await large25.locator('[data-codex-mods-legacy]').count(), 0);
  const chineseGeometry = await Promise.all(rows.map(row => row.evaluate(node => {
    const title = node.querySelector('[data-thread-title-trigger]').getBoundingClientRect();
    const rect = element => { const target = node.querySelector(element); if (!target) return null; const value = target.getBoundingClientRect(); return [value.x, value.y, value.width, value.height]; };
    return { title: [title.x, title.y], active: rect('.active-control'), hover: rect('.hover-control') };
  })));
  assert.deepEqual(chineseGeometry, initialGeometry, 'localized copy must preserve native title and control geometry');
  await page.setViewportSize({ width: 1100, height: 650 });

  for (const row of [aged, threshold]) {
    for (const control of [row.locator('.active-control'), row.locator('.hover-control')]) {
      const box = await control.boundingBox();
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.className, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      assert.equal(hit, await control.getAttribute('class'), 'metadata must not cover native controls');
      await control.click();
    }
  }
  assert.equal(await page.evaluate(() => window.nativeControlClicks), 4, 'native controls should receive their own clicks');
  assert.equal(await page.evaluate(() => window.archiveActions), 1, 'only the explicit native Archive chat button should archive');

  const updateStatus = await page.evaluate(() => globalThis.__codexModsSidebarTime.setSessionActivity({
    aged: window.__fixedNow - 47 * 60 * 60 * 1000,
    threshold: window.__fixedNow - 48 * 60 * 60 * 1000,
    recent: window.__fixedNow - 47 * 60 * 60 * 1000,
    future: window.__fixedNow + 60 * 60 * 1000,
  }, null, 8));
  assert.equal(updateStatus.activityRevision, 8);
  assert.equal(updateStatus.legacyBadges, 0, 'a new message must clear the archive recommendation');
  assert.equal(await aged.locator('[data-codex-mods-legacy]').count(), 0);

  await page.evaluate(cleanupExpression);
  for (const [index, row] of rows.entries()) {
    assert.equal(await row.evaluate(node => getComputedStyle(node).position), 'static');
    assert.equal(await row.locator('[data-codex-mods-time], [data-codex-mods-legacy], [data-codex-mods-size]').count(), 0);
    assert.deepEqual(await row.evaluate(node => {
      const title = node.querySelector('[data-thread-title-trigger]').getBoundingClientRect();
      const rect = element => { const target = node.querySelector(element); if (!target) return null; const value = target.getBoundingClientRect(); return [value.x, value.y, value.width, value.height]; };
      return { title: [title.x, title.y], active: rect('.active-control'), hover: rect('.hover-control') };
    }), initialGeometry[index]);
  }
  assert.equal(await page.locator('[data-codex-mods-style], .codex-mods-time-row, [data-codex-mods-legacy]').count(), 0);

  await page.evaluate(payload({ showTime: false, showLegacy: false, showSize: true, lastMessages: { aged: now - 100 * 60 * 60 * 1000 }, sessionSizes: { aged: 13 * 1024 ** 2 }, refreshMs: 1000 }));
  assert.equal(await aged.locator('[data-codex-mods-legacy]').count(), 0);
  assert.equal(await page.locator('[data-codex-mods-size]').count(), 1);
  assert.equal(await aged.locator('[data-codex-mods-size]').textContent(), '13 MiB');
  assert.equal(await aged.locator('[data-codex-mods-size]').evaluate(node => getComputedStyle(node, '::before').content), 'none', 'size-only mode should not show a separator');
  await page.evaluate(cleanupExpression);
  assert.equal(await page.locator('[data-codex-mods-style], .codex-mods-time-row, [data-codex-mods-legacy], [data-codex-mods-size]').count(), 0);

  await page.evaluate(payload({
    locale: 'en-US', showTime: false, showLegacy: true, showSize: false,
    lastMessages: { aged: now - 49 * 60 * 60 * 1000 },
    sessionSizes: { aged: 119 * 1024 ** 2 },
  }));
  assert.equal(await aged.locator('[data-codex-mods-legacy]').count(), 1, 'legacy-only mode still uses the combined size and age rule');
  assert.equal(await aged.locator('[data-codex-mods-legacy]').getAttribute('data-codex-mods-archive-reason'), 'size');
  assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill]').count(), 0, 'legacy-only mode must not render size UI or background fill');
  assert.equal(await aged.evaluate(node => node.style.backgroundImage), '');
  await page.evaluate(cleanupExpression);
  assert.equal(await page.locator('[data-codex-mods-style], .codex-mods-time-row, [data-codex-mods-legacy]').count(), 0);
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

test('legacy-only CLI reads and refreshes sparse session sizes without displaying size UI', async () => {
  await go();
  const directory = await mkdtemp(join(tmpdir(), 'codex-mods-legacy-e2e-'));
  const home = join(directory, 'codex');
  const stateDirectory = join(directory, 'state');
  const firstId = '11111111-2222-4333-8444-555555555555';
  const archivedId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const sessions = join(home, 'sessions');
  const archived = join(home, 'archived_sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  const firstPath = join(sessions, `rollout-2026-10-01T00-00-00-000Z-${firstId}.jsonl`);
  const historical = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  const archivedHistorical = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const historyRecord = { type: 'response_item', timestamp: historical, payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'Historical user message' }] } };
  const writeSparseRollout = async (path, size, record) => {
    const handle = await openFile(path, 'w+');
    try {
      await handle.truncate(size);
      const tail = Buffer.from(`\n${JSON.stringify(record)}\n`);
      await handle.write(tail, 0, tail.length, size - tail.length);
    } finally { await handle.close(); }
  };
  await writeSparseRollout(firstPath, 100_000_001, historyRecord);
  await page.evaluate(({ id }) => {
    document.querySelector('aside').innerHTML = `<div role="button" tabindex="0" class="activity-row" data-app-action-sidebar-thread-id="local:${id}" data-app-action-sidebar-thread-host-id="local" style="display:flex;align-items:center;width:340px;height:44px;padding:0 8px;box-sizing:border-box"><div style="display:flex;flex:1;min-width:0"><span class="title" data-thread-title-trigger style="flex:1;min-width:0">Historical session</span><span class="status">○</span></div></div>`;
    window.snapshot = { catalogSnapshot: { entries: [{ id, hostId: 'local' }] } };
  }, { id: firstId });

  const environment = { ...process.env, CODEX_MODS_STATE_DIR: stateDirectory };
  const child = spawn(process.execPath, [cliPath, 'enable', 'sidebar-legacy', '--locale', 'en-US', '--codex-home', home, '--endpoint', endpoint, '--no-launch', '--fixture', '--refresh-ms', '1000'], { env: environment });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const mainRow = page.locator(`[data-app-action-sidebar-thread-id="local:${firstId}"]`);
  try {
    await waitFor(async () => await mainRow.locator('[data-codex-mods-legacy]').count() === 1, 'Large historical JSONL message was not marked for archive: ' + output, 10000);
    assert.equal(await mainRow.locator('[data-codex-mods-legacy]').textContent(), 'Archive suggestion');
    assert.equal(await mainRow.locator('[data-codex-mods-legacy]').getAttribute('data-codex-mods-archive-reason'), 'size', 'size and age both exceed their strict thresholds');
    assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill]').count(), 0, 'show-legacy alone must not display size labels or fills');
    assert.equal(await page.locator('[data-codex-mods-time]').count(), 0, 'sidebar-size --show-legacy must not add numeric time labels');
    const controller = await page.evaluate(() => {
      window.__legacyController = globalThis.__codexModsSidebarTime;
      return globalThis.__codexModsSidebarTime.status().activityRevision;
    });
    assert.ok(controller > 0, 'activity reader must deliver a revision');

    await writeSparseRollout(firstPath, 100_000_000, historyRecord);
    await waitFor(async () => await mainRow.locator('[data-codex-mods-legacy]').count() === 0, 'Legacy-only runner should require size strictly above 100,000,000 bytes', 8000);
    await writeSparseRollout(firstPath, 100_000_001, historyRecord);
    await waitFor(async () => await mainRow.locator('[data-codex-mods-legacy]').count() === 1, 'Legacy-only runner did not restore eligibility after size moved above 100,000,000 bytes', 8000);
    assert.equal(await mainRow.locator('[data-codex-mods-legacy]').getAttribute('data-codex-mods-archive-reason'), 'size');
    assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill]').count(), 0, 'size refresh must remain visually silent in legacy-only mode');
    assert.equal(await page.evaluate(() => globalThis.__codexModsSidebarTime === window.__legacyController), true, 'size refresh must update in place without reinjection');

    const recentMessage = { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: 'New user message' } };
    await appendFile(firstPath, `${JSON.stringify(recentMessage)}\n`);
    await waitFor(async () => await mainRow.locator('[data-codex-mods-legacy]').count() === 0, 'A new user message did not clear the archive recommendation', 6000);
    assert.equal(await page.locator('[data-codex-mods-size], [data-codex-mods-fill]').count(), 0, 'new-message refresh must not reveal size UI');
    assert.equal(await page.evaluate(() => globalThis.__codexModsSidebarTime === window.__legacyController), true, 'activity refresh must update in place without reinjection');

    const archivedPath = join(archived, `rollout-2026-10-02T00-00-00-000Z-${archivedId}.jsonl`);
    const archivedMessage = { type: 'response_item', timestamp: archivedHistorical, payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Archived historical message' }] } };
    await writeSparseRollout(archivedPath, 100_000_001, archivedMessage);
    await page.evaluate(({ id }) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('class', 'activity-row');
      row.setAttribute('data-app-action-sidebar-thread-id', `local:${id}`);
      row.setAttribute('data-app-action-sidebar-thread-host-id', 'local');
      row.setAttribute('style', 'display:flex;align-items:center;width:340px;height:44px;padding:0 8px;box-sizing:border-box');
      row.innerHTML = '<div style="display:flex;flex:1;min-width:0"><span class="title" data-thread-title-trigger style="flex:1;min-width:0">Archived session</span><span class="status">○</span></div>';
      document.querySelector('aside').append(row);
    }, { id: archivedId });
    const archivedRow = page.locator(`[data-app-action-sidebar-thread-id="local:${archivedId}"]`);
    await waitFor(async () => await archivedRow.locator('[data-codex-mods-legacy]').count() === 1, 'Archived JSONL session missing from bootstrap did not receive an archive recommendation within about two polling cycles', 3000);
    assert.equal(await archivedRow.locator('[data-codex-mods-legacy]').textContent(), 'Archive suggestion');
    assert.equal(await page.evaluate(() => globalThis.__codexModsSidebarTime === window.__legacyController), true, 'mounting an archived row must not reinject the renderer');

    const disable = spawn(process.execPath, [cliPath, 'disable', 'sidebar-legacy'], { env: environment });
    let disableOutput = '';
    disable.stdout.on('data', data => { disableOutput += data; });
    disable.stderr.on('data', data => { disableOutput += data; });
    assert.equal(await new Promise(resolve => disable.once('exit', resolve)), 0, disableOutput);
    assert.equal(JSON.parse(disableOutput).cleanupConfirmed, true);
    assert.equal(await exited, 0, output);
    assert.equal(await page.locator('[data-codex-mods-legacy], [data-codex-mods-size], [data-codex-mods-style], .codex-mods-time-row').count(), 0);
    await page.reload();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await page.locator('[data-codex-mods-legacy], [data-codex-mods-size], [data-codex-mods-time]').count(), 0, 'disabled registration must not restore labels on reload');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(directory, { recursive: true, force: true });
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
