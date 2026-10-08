// This function is serialized and evaluated inside the desktop renderer.
// Keep it self-contained. It never writes thread names or application data.
export function sidebarTime(options = {}) {
  const key = '__codexModsSidebarTime';
  const w = globalThis;
  w[key]?.dispose?.();
  const selector = '[data-app-action-sidebar-thread-id], [data-thread-id], [data-conversation-id], a[href]';
  const findBridge = () => [w.electronBridge, w.codexBridge, w.electronAPI]
    .find((candidate) => typeof candidate?.getInitialSidebarBootstrap === 'function');
  let disposed = false;
  let pending = false;
  let polling = false;
  let lastError = null;
  let lastRefreshAt = null;
  let source = 'none';
  let entries = [];
  const owned = new Set();
  const className = 'codex-mods-time-row';
  const badgeSelector = '[data-codex-mods-time]';
  const css = document.createElement('style');
  css.dataset.codexModsStyle = 'sidebar-time';
  css.textContent = `.${className} > ${badgeSelector} { display:inline-block; flex:0 0 auto; min-width:3.5ch; margin-inline-end:8px; font-size:11px; font-variant-numeric:tabular-nums; line-height:inherit; color:inherit; opacity:.65; pointer-events:none; white-space:nowrap; vertical-align:baseline; }`;

  function timestamp(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && !Number.isFinite(Number(value))) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 100_000_000_000 ? number * 1000 : number;
  }

  function fieldTime(thread) {
    if (options.timeField === 'created') return timestamp(thread.createdAt ?? thread.created_at);
    if (options.timeField === 'updated') return timestamp(thread.updatedAt ?? thread.updated_at);
    return timestamp(thread.recencyAt ?? thread.recency_at) ?? timestamp(thread.updatedAt ?? thread.updated_at);
  }

  function collect(value) {
    const found = [];
    const candidates = [value?.catalogSnapshot?.entries, value?.entries, value?.threads, value?.data, Array.isArray(value) ? value : null];
    for (const list of candidates) {
      if (!Array.isArray(list)) continue;
      for (const entry of list.slice(0, 10000)) {
        const thread = entry?.thread ?? entry?.task?.conversation ?? entry?.task ?? entry;
        const id = thread?.id ?? thread?.threadId ?? thread?.conversationId;
        const time = thread && fieldTime(thread);
        if (typeof id !== 'string' || !id || time == null) continue;
        const host = entry.hostId ?? thread.hostId ?? null;
        found.push({ id, host: typeof host === 'string' ? host : null, time });
      }
    }
    return found;
  }

  function rowIdentity(row) {
    const qualified = row.getAttribute('data-app-action-sidebar-thread-id');
    if (qualified) return { qualified };
    const id = row.getAttribute('data-thread-id') ?? row.getAttribute('data-conversation-id');
    if (id) return { id, host: row.getAttribute('data-host-id') };
    if (row.tagName === 'A') {
      try {
        const path = new URL(row.getAttribute('href'), location.href).pathname;
        const match = path.match(/^\/(?:threads?|c)\/([^/]+)\/?$/);
        if (match) return { id: decodeURIComponent(match[1]), host: row.getAttribute('data-host-id') };
      } catch { /* Unsupported href: do not guess from text. */ }
    }
    return null;
  }

  function findTime(identity, row) {
    const matches = entries.filter((entry) => identity.qualified
      ? `${entry.host ?? 'local'}:${entry.id}` === identity.qualified || entry.id === identity.qualified
      : entry.id === identity.id && (identity.host == null || entry.host === identity.host));
    // Conflicting hosts/timestamps must not be matched by title or row order.
    const unique = new Set(matches.map((entry) => `${entry.host}:${entry.time}`));
    if (unique.size === 1) return matches[0].time;
    if (unique.size > 1) return null;
    const nativeField = options.timeField === 'created' ? 'data-created-at' : options.timeField === 'updated' ? 'data-updated-at' : 'data-recency-at';
    const explicit = timestamp(row.getAttribute(nativeField));
    if (explicit != null) return explicit;
    if (options.timeField !== 'created') return timestamp(row.getAttribute('data-updated-at'));
    return null;
  }

  function relative(time) {
    const seconds = Math.max(0, (Date.now() - time) / 1000);
    if (seconds < 60) return '<1m';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d`;
    if (seconds < 365 * 86400) return `${Math.floor(seconds / (30 * 86400))}mo`;
    return `${Math.floor(seconds / (365 * 86400))}y`;
  }

  function rows() {
    const nodes = [...document.querySelectorAll(options.rowSelector || selector)].filter((row) => {
      const inSidebar = options.rowSelector || row.hasAttribute('data-app-action-sidebar-thread-id') || row.closest('aside, nav, [data-sidebar], [data-testid="sidebar"], [data-testid="left-panel"], [data-testid="app-sidebar"]');
      return inSidebar && rowIdentity(row);
    });
    return nodes.filter((row) => !nodes.some((other) => other !== row && other.contains(row) && JSON.stringify(rowIdentity(other)) === JSON.stringify(rowIdentity(row))));
  }

  function remove(row) {
    for (const node of [...row.children]) if (node.matches(badgeSelector)) node.remove();
    row.classList.remove(className);
    owned.delete(row);
  }

  function render() {
    if (disposed || !document.documentElement) return;
    if (!css.isConnected) (document.head || document.documentElement).append(css);
    const active = new Set();
    for (const row of rows()) {
      const time = findTime(rowIdentity(row), row);
      if (time == null) { if (owned.has(row)) remove(row); continue; }
      active.add(row);
      let badge = [...row.children].find((child) => child.matches(badgeSelector));
      if (!badge) {
        badge = document.createElement('span');
        badge.dataset.codexModsTime = 'sidebar-time';
        row.prepend(badge);
      }
      const label = relative(time);
      if (badge.textContent !== label) badge.textContent = label;
      const exact = new Date(time).toLocaleString();
      badge.title = exact;
      badge.setAttribute('aria-label', `${options.timeField === 'created' ? 'Created' : options.timeField === 'updated' ? 'Updated' : 'Last activity'}: ${exact}`);
      row.classList.add(className);
      owned.add(row);
    }
    for (const row of [...owned]) if (!active.has(row)) remove(row);
  }

  function schedule() {
    if (disposed || pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; if (!disposed) render(); });
  }

  async function refresh() {
    if (disposed || polling) return;
    polling = true;
    try {
      const bridge = findBridge();
      let value;
      if (options.threads) { value = options.threads; source = 'threads-file'; }
      else if (bridge) {
        let deadline;
        try {
          value = await Promise.race([
            Promise.resolve(bridge.getInitialSidebarBootstrap()),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('timeout')), 2500); }),
          ]);
        } finally { clearTimeout(deadline); }
        source = 'desktop-bootstrap';
      }
      if (disposed) return;
      entries = collect(value);
      lastRefreshAt = Date.now();
      lastError = null;
      render();
    } catch {
      // Keep the last good snapshot and disclose that it may be stale.
      lastError = 'Thread metadata refresh failed; the last successful snapshot may be stale.';
    } finally { polling = false; }
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !(mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement)?.closest?.(badgeSelector))) schedule();
  });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-app-action-sidebar-thread-id', 'data-thread-id', 'data-conversation-id', 'data-host-id', 'data-updated-at', 'data-recency-at', 'data-created-at'] });
  const timer = setInterval(refresh, options.refreshMs || 30000);
  const status = () => ({
    installed: !disposed,
    rows: rows().length,
    badges: document.querySelectorAll(badgeSelector).length,
    metadataEntries: entries.length,
    provider: source === 'none' && owned.size ? 'dom-attributes' : source,
    bootstrapAvailable: !!findBridge(),
    lastRefreshAt,
    warning: lastError,
  });
  function dispose() {
    disposed = true;
    observer.disconnect();
    clearInterval(timer);
    for (const row of [...owned]) remove(row);
    css.remove();
    if (w[key]?.dispose === dispose) delete w[key];
  }
  w[key] = { status, dispose, refresh };
  return refresh().then(status);
}

export function payload(options) {
  return `(${sidebarTime.toString()})(${JSON.stringify(options)})`;
}

export const cleanupExpression = '(() => { globalThis.__codexModsSidebarTime?.dispose(); return { removed: !globalThis.__codexModsSidebarTime }; })()';
export const statusExpression = 'globalThis.__codexModsSidebarTime?.status() ?? null';
