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
  let sessionSizes = options.sessionSizes || {};
  let sizeWarning = options.sizeWarning || null;
  let sizeRevision = options.sizeRevision ?? 0;
  const owned = new Set();
  const className = 'codex-mods-time-row';
  const badgeSelector = '[data-codex-mods-time]';
  const sizeSelector = '[data-codex-mods-size]';
  const ownedBadgeSelector = `${badgeSelector}, ${sizeSelector}`;
  const css = document.createElement('style');
  css.dataset.codexModsStyle = 'sidebar-time';
  css.textContent = `
    .${className} ${badgeSelector}, .${className} ${sizeSelector} { display:inline-block; flex:0 0 auto; min-width:3.5ch; margin-inline-end:8px; font-size:11px; font-variant-numeric:tabular-nums; line-height:inherit; color:inherit; white-space:nowrap; vertical-align:baseline; }
    .${className} ${badgeSelector} { pointer-events:none; }
    .${className} ${sizeSelector} { margin-inline-start:auto; min-width:7.5ch; text-align:end; }
    .${className}:is(:hover, :focus-within, :has([aria-expanded="true"])) ${sizeSelector}[data-codex-mods-hover-actions] { visibility:hidden; }
    .${className}[data-codex-mods-fill] { background-image:linear-gradient(90deg, color-mix(in srgb, currentColor 7%, transparent), color-mix(in srgb, currentColor 3%, transparent)); background-size:var(--codex-mods-fill) 100%; background-repeat:no-repeat; }
    @media (forced-colors: active) { .${className}[data-codex-mods-fill] { background-image:none; } }
  `;

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

  function supportedKind(kind, fallback) {
    if (kind == null || kind === '') return fallback;
    if (kind === 'local') return 'local';
    if (kind === 'cloud' || kind === 'hosted' || kind === 'remote') return 'hosted';
    return null;
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
        if (typeof id !== 'string' || !id) continue;
        const host = entry.hostId ?? thread.hostId ?? null;
        const kind = supportedKind(entry.kind, entry.task && !entry.thread ? 'hosted' : 'local');
        found.push({ id, host: typeof host === 'string' ? host : null, kind, time });
      }
    }
    return found;
  }

  function rowIdentity(row) {
    const qualified = row.getAttribute('data-app-action-sidebar-thread-id');
    const nativeHost = row.getAttribute('data-app-action-sidebar-thread-host-id');
    const host = (nativeHost ?? row.getAttribute('data-host-id')) || null;
    const nativeKind = row.getAttribute('data-app-action-sidebar-thread-kind');
    const kind = supportedKind(nativeKind, 'local');
    if (!kind) return null;
    if (qualified) {
      if (qualified.startsWith('hosted:') || (qualified.startsWith('remote:') && nativeKind !== 'local')) {
        if (nativeKind && kind !== 'hosted') return null;
        return { id: qualified.slice(7), host: null, kind: 'hosted' };
      }
      // The native sidebar uses local:<threadId>, with host in its own attribute.
      if (qualified.startsWith('local:') && qualified.indexOf(':', 6) === -1) {
        if (kind !== 'local' || !qualified.slice(6)) return null;
        return { id: qualified.slice(6), host: nativeHost === '' ? null : host ?? 'local', kind, unknownHost:nativeHost === '' };
      }
      // Also accept qualified adapters; host IDs may contain colons.
      const key = qualified.startsWith('local:') && qualified.indexOf(':', 6) !== -1 ? qualified.slice(6) : qualified;
      const split = key.lastIndexOf(':');
      if (split !== -1) {
        const keyHost = key.slice(0, split);
        const id = key.slice(split + 1);
        if (!id || !keyHost || (host != null && host !== keyHost) || kind !== 'local') return null;
        return { id, host: keyHost, kind: 'local' };
      }
      return { id: qualified, host, kind, unknownHost:nativeHost === '' };
    }
    const id = row.getAttribute('data-thread-id') ?? row.getAttribute('data-conversation-id');
    if (id) return { id, host, kind };
    if (row.tagName === 'A') {
      try {
        const path = new URL(row.getAttribute('href'), location.href).pathname;
        const match = path.match(/^\/(?:threads?|c)\/([^/]+)\/?$/);
        if (match) return { id: decodeURIComponent(match[1]), host, kind };
      } catch { /* Unsupported href: do not guess from text. */ }
    }
    return null;
  }

  function findTime(identity, row) {
    if (identity.kind === 'local' && identity.host == null && entries.some(entry => entry.id === identity.id && entry.kind == null)) return null;
    const matches = entries.filter((entry) => entry.time != null && entry.id === identity.id && entry.kind === identity.kind &&
      (identity.host == null || (entry.host ?? 'local') === identity.host));
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

  function findSize(identity) {
    if (!options.showSize || identity.kind !== 'local' || identity.unknownHost || (identity.host && identity.host !== 'local')) return null;
    const matches = entries.filter(entry => entry.id === identity.id);
    if (!identity.host && matches.some(entry => entry.kind !== 'local' || (entry.host && entry.host !== 'local'))) return null;
    const bytes = sessionSizes[identity.id?.toLowerCase()];
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let amount = bytes / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unit]}`;
  }

  function rows() {
    const nodes = [...document.querySelectorAll(options.rowSelector || selector)].filter((row) => {
      const inSidebar = options.rowSelector || row.hasAttribute('data-app-action-sidebar-thread-id') || row.closest('aside, nav, [data-sidebar], [data-testid="sidebar"], [data-testid="left-panel"], [data-testid="app-sidebar"]');
      return inSidebar && rowIdentity(row);
    });
    return nodes.filter((row) => !nodes.some((other) => other !== row && other.contains(row) && JSON.stringify(rowIdentity(other)) === JSON.stringify(rowIdentity(row))));
  }

  function remove(row) {
    for (const node of row.querySelectorAll(ownedBadgeSelector)) node.remove();
    row.classList.remove(className);
    row.removeAttribute('data-codex-mods-fill');
    row.style.removeProperty('--codex-mods-fill');
    owned.delete(row);
  }

  function render() {
    if (disposed || !document.documentElement) return;
    if (!css.isConnected) (document.head || document.documentElement).append(css);
    const active = new Set();
    for (const row of rows()) {
      const identity = rowIdentity(row);
      const time = options.showTime === false ? null : findTime(identity, row);
      const bytes = findSize(identity);
      if (time == null && bytes == null) { if (owned.has(row)) remove(row); continue; }
      // Native rows group title, status, and actions in nested flex containers.
      const title = row.querySelector('[data-thread-title-trigger]');
      const container = title?.parentElement ?? row;
      if (title && getComputedStyle(container).display !== 'flex') { if (owned.has(row)) remove(row); continue; }
      active.add(row);
      let badge = row.querySelector(badgeSelector);
      if (time == null) { badge?.remove(); }
      else {
        if (!badge) {
          badge = document.createElement('span');
          badge.dataset.codexModsTime = 'sidebar-time';
        }
        if (badge.parentElement !== container) container.insertBefore(badge, title ?? container.firstChild);
        const label = relative(time);
        if (badge.textContent !== label) badge.textContent = label;
        const exact = new Date(time).toLocaleString();
        badge.title = exact;
        badge.setAttribute('aria-label', `${options.timeField === 'created' ? 'Created' : options.timeField === 'updated' ? 'Updated' : 'Last activity'}: ${exact}`);
      }
      let sizeBadge = row.querySelector(sizeSelector);
      if (bytes == null) {
        sizeBadge?.remove();
        row.removeAttribute('data-codex-mods-fill');
        row.style.removeProperty('--codex-mods-fill');
      }
      else {
        if (!sizeBadge) {
          sizeBadge = document.createElement('span');
          sizeBadge.dataset.codexModsSize = 'sidebar-size';
        }
        if (sizeBadge.parentElement !== container) {
          if (title) container.insertBefore(sizeBadge, title.nextSibling);
          else {
            const trailing = container.lastElementChild;
            if (trailing && trailing !== badge && container.children.length > (badge ? 2 : 1)) container.insertBefore(sizeBadge, trailing);
            else container.append(sizeBadge);
          }
        }
        sizeBadge.toggleAttribute('data-codex-mods-hover-actions', !!row.querySelector('[data-hover-card-open-immediately] button, [data-hover-card-open-immediately] [role="button"]'));
        const label = fileSize(bytes);
        if (sizeBadge.textContent !== label) sizeBadge.textContent = label;
        const description = `Local session records: ${bytes.toLocaleString()} bytes. File size; excludes attachments and workspace files.`;
        sizeBadge.title = description;
        sizeBadge.setAttribute('aria-label', description);
        // Respect rows which already use a native background image.
        if (row.hasAttribute('data-codex-mods-fill') || getComputedStyle(row).backgroundImage === 'none') {
          const fill = Math.min(1, Math.log1p(bytes / 1024) / Math.log1p(1024 * 1024));
          row.style.setProperty('--codex-mods-fill', `${(fill * 100).toFixed(2)}%`);
          row.setAttribute('data-codex-mods-fill', '');
        }
      }
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
    if (mutations.some((mutation) => !(mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement)?.closest?.(ownedBadgeSelector))) schedule();
  });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id', 'data-app-action-sidebar-thread-kind', 'data-thread-id', 'data-conversation-id', 'data-host-id', 'data-updated-at', 'data-recency-at', 'data-created-at'] });
  const timer = setInterval(refresh, options.refreshMs || 30000);
  const status = () => ({
    installed: !disposed,
    rows: rows().length,
    badges: document.querySelectorAll(badgeSelector).length,
    sizeBadges: document.querySelectorAll(sizeSelector).length,
    sizeRevision,
    sizeEntries: Object.keys(sessionSizes).length,
    metadataEntries: entries.length,
    provider: source === 'none' && owned.size ? 'dom-attributes' : source,
    bootstrapAvailable: !!findBridge(),
    lastRefreshAt,
    warning: [lastError, sizeWarning].filter(Boolean).join(' ') || null,
  });
  function dispose() {
    disposed = true;
    observer.disconnect();
    clearInterval(timer);
    for (const row of [...owned]) remove(row);
    css.remove();
    if (w[key]?.dispose === dispose) delete w[key];
  }
  const setSessionSizes = (sizes, warning = null, revision = 0) => {
    if (disposed) return;
    sessionSizes = sizes || {};
    sizeWarning = warning;
    sizeRevision = revision;
    render();
    return status();
  };
  w[key] = { status, dispose, refresh, setSessionSizes };
  return refresh().then(status);
}

export function payload(options) {
  return `(${sidebarTime.toString()})(${JSON.stringify(options)})`;
}

export const cleanupExpression = '(() => { globalThis.__codexModsSidebarTime?.dispose(); return { removed: !globalThis.__codexModsSidebarTime }; })()';
export const statusExpression = 'globalThis.__codexModsSidebarTime?.status() ?? null';
