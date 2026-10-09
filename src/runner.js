import { readFile } from 'node:fs/promises';
import { CDP, targets } from './cdp.js';
import { payload, cleanupExpression, statusExpression } from './renderer.js';
import { readJSON, writeJSON, lock, processAlive } from './state.js';
import { ensureEndpoint } from './launcher.js';
import { readSessionSizes } from './sessions.js';

const probeExpression = `(() => ({
  bootstrapAvailable: [globalThis.electronBridge, globalThis.codexBridge, globalThis.electronAPI].some(b => typeof b?.getInitialSidebarBootstrap === 'function'),
  nativeRows: document.querySelectorAll('[data-app-action-sidebar-thread-id]').length,
  plugin: globalThis.__codexModsSidebarTime?.status() ?? null
}))()`;

export async function doctor(options) {
  const list = await targets(options.endpoint, options.fixture);
  const reports = [];
  for (const target of list) {
    let client;
    try {
      client = await CDP.connect(target, options.endpoint);
      reports.push({ targetId: target.id, protocol: new URL(target.url).protocol, ...await client.evaluate(probeExpression) });
    } catch (error) { reports.push({ targetId: target.id, error: error.message }); }
    finally { client?.close(); }
  }
  return { endpoint: options.endpoint, targets: reports, compatibleTargets: reports.filter(r => r.bootstrapAvailable || r.nativeRows || r.plugin).length };
}

async function stripRegistration(record, endpoint) {
  endpoint = record.endpoint || endpoint;
  const current = (await targets(endpoint, true)).find(target => target.id === record.id);
  // A destroyed target cannot retain either the DOM or a new-document script.
  if (!current) return;
  const client = await CDP.connect(current, endpoint);
  try {
    if (record.scriptId) {
      try { await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: record.scriptId }); }
      catch (error) { if (!/Script not found|No script with given id|Could not find script/i.test(error.message)) throw error; }
    }
    await client.evaluate(cleanupExpression);
  } finally { client.close(); }
}

export async function disable(options) {
  const previous = await readJSON(options.directory, 'config.json', {});
  await writeJSON(options.directory, 'config.json', { ...previous, enabled: false });
  const watcher = await readJSON(options.directory, 'watcher.lock');
  if (watcher && processAlive(watcher.pid)) {
    const deadline = Date.now() + 15000;
    while ((await readJSON(options.directory, 'watcher.lock'))?.token === watcher.token && processAlive(watcher.pid)) {
      if (Date.now() >= deadline) return { enabled: false, cleanupConfirmed: false, failures: [{ error: 'The watcher has not finished cleanup. Wait, then run disable again.' }] };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const registry = await readJSON(options.directory, 'registrations.json', { targets: [] });
  const failures = [];
  // The watcher owns cleanup while it is running. The registry also permits cleanup after a crash.
  for (const record of registry.targets) {
    try { await stripRegistration(record, registry.endpoint); }
    catch (error) { failures.push({ targetId: record.id, error: error.message }); }
  }
  if (!failures.length) await writeJSON(options.directory, 'registrations.json', { targets: [] });
  return { enabled: false, cleanupConfirmed: failures.length === 0, failures };
}

export async function enable(options, log = console.log) {
  const unlock = await lock(options.directory);
  let stopping = false;
  const controller = new AbortController();
  const stop = () => { stopping = true; controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const active = new Map();
  const clients = new Map();
  let residual = [];
  const statusCache = new Map();
  const rendererOptions = { timeField: options.timeField, rowSelector: options.rowSelector, refreshMs: options.refreshMs, showTime: options.showTime, showSize: options.showSize };
  let sizeRefreshAt = 0;
  let sizeRevision = 0;
  let mainError;
  try {
    if (options.threadsFile) {
      rendererOptions.threads = JSON.parse(await readFile(options.threadsFile, 'utf8'));
      if (!Array.isArray(rendererOptions.threads) && !rendererOptions.threads?.catalogSnapshot && !rendererOptions.threads?.threads && !rendererOptions.threads?.data) {
        throw new Error('--threads-file must contain a thread array, thread/list response, or catalog bootstrap.');
      }
    }
    // Clear registrations left by a crashed watcher before creating new ones.
    const old = await readJSON(options.directory, 'registrations.json', { targets: [] });
    residual = old.targets.map(record => ({ ...record, endpoint: record.endpoint || old.endpoint }));
    for (const record of old.targets) {
      try { await stripRegistration(record, old.endpoint); residual = residual.filter(item => item.id !== record.id); }
      catch { throw new Error('Previous injection cleanup could not be confirmed. Fully quit/reopen the desktop app, then remove stale registrations with codex-mods disable sidebar-time.'); }
    }
    await ensureEndpoint({ ...options, signal: controller.signal }, log);
    await writeJSON(options.directory, 'config.json', { enabled: true, endpoint: options.endpoint, fixture: options.fixture });
    let source = payload(rendererOptions);
    log('Watching Codex desktop windows. Keep this command running; Ctrl+C removes the injection.');
    let lastDiscoveryWarning = null;
    const persist = () => writeJSON(options.directory, 'registrations.json', { endpoint: options.endpoint, targets: [...active.values()] });
    while (!stopping && (await readJSON(options.directory, 'config.json', {})).enabled) {
      try {
        if (options.showSize && (!sizeRefreshAt || Date.now() - sizeRefreshAt >= (options.refreshMs || 30000))) {
          const snapshot = await readSessionSizes(options.codexHome);
          rendererOptions.sessionSizes = snapshot.sizes;
          rendererOptions.sizeWarning = snapshot.warning;
          rendererOptions.sizeRevision = ++sizeRevision;
          sizeRefreshAt = Date.now();
          source = payload(rendererOptions);
        }
        const list = await targets(options.endpoint, options.fixture);
        const liveIDs = new Set(list.map(item => item.id));
        for (const [id, client] of clients) if (!liveIDs.has(id)) { client.close(); clients.delete(id); active.delete(id); statusCache.delete(id); }
        await persist();
        for (const target of list) {
          let client;
          try {
            client = clients.get(target.id);
            if (!client || client.socket.readyState !== WebSocket.OPEN) {
              client?.close();
              client = await CDP.connect(target, options.endpoint);
              await client.send('Page.enable');
              clients.set(target.id, client);
              // New-document registrations belong to a CDP session, not just a page.
              active.delete(target.id);
            }
            let state;
            if (!active.has(target.id)) {
              const probe = await client.evaluate(probeExpression);
              if (!probe.bootstrapAvailable && !probe.nativeRows && !options.fixture && !options.rowSelector) { client.close(); clients.delete(target.id); continue; }
              const earlySource = `(() => { const install = () => { void ${source}; }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install(); })()`;
              const early = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: earlySource });
              const record = { id: target.id, endpoint: options.endpoint, webSocketDebuggerUrl: target.webSocketDebuggerUrl, scriptId: early.identifier };
              active.set(target.id, record);
              await persist();
              state = await client.evaluate(source);
            } else {
              state = await client.evaluate(statusExpression);
              if (!state) state = await client.evaluate(source);
            }
            if (options.showSize && state?.sizeRevision !== sizeRevision) {
              state = await client.evaluate(`globalThis.__codexModsSidebarTime?.setSessionSizes(${JSON.stringify(rendererOptions.sessionSizes)}, ${JSON.stringify(rendererOptions.sizeWarning)}, ${sizeRevision})`);
            }
            const summary = state?.badges || state?.sizeBadges
              ? `${options.plugin || 'sidebar-time'}: ${state.badges || 0} time labels, ${state.sizeBadges || 0} size labels visible.${state.warning ? ` ${state.warning}` : ''}`
              : `${options.plugin || 'sidebar-time'}: waiting for supported thread rows and metadata; no labels verified yet.${state?.warning ? ` ${state.warning}` : ''}`;
            if (statusCache.get(target.id) !== summary) { statusCache.set(target.id, summary); log(summary); }
          } catch (error) {
            log(`Window adapter: ${error.message}`);
            // Keep a registered session until cleanup; dropping it would remove its reload hook.
            if (!active.has(target.id)) { client?.close(); clients.delete(target.id); }
          }
        }
        lastDiscoveryWarning = null;
      } catch (error) {
        if (lastDiscoveryWarning !== error.message) { log(`Waiting for CDP: ${error.message}`); lastDiscoveryWarning = error.message; }
      }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) { if (!stopping || error.name !== 'AbortError') mainError = error; }
  finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    const failed = [];
    for (const record of active.values()) {
      try {
        const owner = clients.get(record.id);
        if (owner?.socket.readyState === WebSocket.OPEN) {
          if (record.scriptId) await owner.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: record.scriptId });
          await owner.evaluate(cleanupExpression);
        } else await stripRegistration(record, options.endpoint);
      }
      catch (error) { failed.push(record); log(`Cleanup not confirmed for one window: ${error.message}. Run disable again, or fully restart the app.`); }
    }
    for (const client of clients.values()) client.close();
    try {
      await writeJSON(options.directory, 'registrations.json', { endpoint: options.endpoint, targets: [...residual, ...failed] });
      await writeJSON(options.directory, 'config.json', { enabled: false, endpoint: options.endpoint, fixture: options.fixture });
    } finally { await unlock(); }
  }
  if (mainError) throw mainError;
}
