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
  let lastMessages = options.lastMessages || {};
  let activityWarning = options.activityWarning || null;
  let activityRevision = options.activityRevision ?? 0;
  const owned = new Set();
  const className = 'codex-mods-time-row';
  const badgeSelector = '[data-codex-mods-time]';
  const sizeSelector = '[data-codex-mods-size]';
  const legacySelector = '[data-codex-mods-legacy]';
  const ownedBadgeSelector = `${badgeSelector}, ${legacySelector}, ${sizeSelector}`;
  const language = options.locale || document.documentElement.lang || navigator.language || 'en';
  const chinese = /^zh\b/i.test(language);
  const nativeArchiveLabel = /^zh\b/i.test(document.documentElement.lang) ? '归档' : 'Archive chat';
  const archiveCopy = chinese ? {
    label: '建议归档',
    reason: (bytes) => `记录超过 100 MB（当前 ${fileSize(bytes)}），且超过 48 小时没有新消息。`,
    history: '归档后从侧边栏收起，记录保留，之后可恢复；不会释放磁盘空间。',
    action: `悬停会话，点击右侧“${nativeArchiveLabel}”按钮归档。`,
    lastMessage: '最后一条消息',
  } : {
    label: 'Archive suggestion',
    reason: (bytes) => `Session records exceed 100 MB (${fileSize(bytes)}), with no new messages for over 48 hours.`,
    history: 'Archiving hides this chat from the sidebar; its history stays saved and can be restored. Archiving does not free disk space.',
    action: 'Hover the chat, then use its Archive button on the right.',
    lastMessage: 'Last message',
  };
  const css = document.createElement('style');
  css.dataset.codexModsStyle = 'sidebar-time';
  css.textContent = `
    .${className} ${badgeSelector}, .${className} ${sizeSelector} { display:inline-block; flex:0 0 auto; min-width:3.5ch; font-size:11px; font-variant-numeric:tabular-nums; line-height:inherit; color:inherit; white-space:nowrap; vertical-align:baseline; }
    .${className} ${badgeSelector} { margin-inline-start:auto; text-align:end; pointer-events:none; }
    .${className} ${badgeSelector}:has(+ ${sizeSelector})::after { content:' ·'; }
    .${className} ${sizeSelector} { margin-inline-start:auto; min-width:7.5ch; text-align:end; }
    .${className} ${badgeSelector} + ${sizeSelector} { margin-inline-start:0; }
    .${className} ${legacySelector} { display:inline-flex; align-items:center; flex:0 0 auto; margin-inline-start:auto; min-height:20px; box-sizing:border-box; padding:1px 5px; border-radius:4px; background:color-mix(in srgb, currentColor 7%, transparent); font-size:10px; line-height:1.4; color:inherit; white-space:nowrap; }
    .${className} ${legacySelector} + ${sizeSelector} { margin-inline-start:0; }
    .${className} ${legacySelector} + ${sizeSelector}::before { content:'· '; opacity:.6; }
    .${className}:is(:hover, :focus-within, :has([aria-expanded="true"])) ${legacySelector},
    .${className}:is(:hover, :focus-within, :has([aria-expanded="true"])) ${legacySelector} + ${sizeSelector}::before { visibility:hidden; }
    .${className}:is(:hover, :focus-within, :has([aria-expanded="true"])) ${sizeSelector}[data-codex-mods-hover-actions] { visibility:hidden; }
    .${className}:is(:hover, :focus-within, :has([aria-expanded="true"])) ${badgeSelector}[data-codex-mods-hover-actions] { visibility:hidden; }
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
    if (options.timeField === 'created') return timestamp(thread.createdAt ?? thread.created_at ?? thread.sourceCreatedAt);
    if (options.timeField === 'updated') return timestamp(thread.updatedAt ?? thread.updated_at ?? thread.sourceUpdatedAt);
    return timestamp(thread.recencyAt ?? thread.recency_at ?? thread.sourceRecencyAt) ?? timestamp(thread.updatedAt ?? thread.updated_at ?? thread.sourceUpdatedAt);
  }

  function supportedKind(kind, fallback) {
    if (kind == null || kind === '') return fallback;
    if (kind === 'local') return 'local';
    if (kind === 'cloud' || kind === 'hosted' || kind === 'remote') return 'hosted';
    return null;
  }

  function collect(value) {
    const found = [];
    const candidates = [value?.catalogSnapshot?.entries, value?.catalogEntries, value?.entries, value?.threads, value?.data, Array.isArray(value) ? value : null];
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

  function isLocalSession(identity) {
    if (identity.kind !== 'local' || identity.unknownHost || (identity.host && identity.host !== 'local')) return false;
    const matches = entries.filter(entry => entry.id === identity.id);
    return !!identity.host || !matches.some(entry => entry.kind !== 'local' || (entry.host && entry.host !== 'local'));
  }

  function findSize(identity) {
    if (!isLocalSession(identity)) return null;
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

  function archiveReason(lastMessage, bytes) {
    if (!options.showLegacy || !Number.isFinite(lastMessage) || lastMessage <= 0) return null;
    const idleHours = (Date.now() - lastMessage) / (60 * 60 * 1000);
    return bytes != null && bytes > 100_000_000 && idleHours > 48 ? 'size' : null;
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
      const recordBytes = findSize(identity);
      const bytes = options.showSize ? recordBytes : null;
      const lastMessage = options.showLegacy && isLocalSession(identity) ? lastMessages[identity.id.toLowerCase()] : null;
      const busy = row.getAttribute('aria-busy') === 'true' || !!row.querySelector('[role="status"], [aria-busy="true"]');
      const reason = busy ? null : archiveReason(lastMessage, recordBytes);
      const legacy = reason != null;
      if (time == null && bytes == null && !legacy) { if (owned.has(row)) remove(row); continue; }
      // Native rows group title, status, and actions in nested flex containers.
      const title = row.querySelector('[data-thread-title-trigger]');
      const container = title?.parentElement ?? row;
      if (title && getComputedStyle(container).display !== 'flex') { if (owned.has(row)) remove(row); continue; }
      active.add(row);
      row.classList.add(className);
      let badge = row.querySelector(badgeSelector);
      if (time == null) { badge?.remove(); }
      else {
        if (!badge) {
          badge = document.createElement('span');
          badge.dataset.codexModsTime = 'sidebar-time';
        }
        if (title) {
          if (title.nextSibling !== badge) container.insertBefore(badge, title.nextSibling);
        } else if (badge.parentElement !== container) {
          const trailing = container.lastElementChild;
          if (trailing && !trailing.matches(ownedBadgeSelector)) container.insertBefore(badge, trailing);
          else container.append(badge);
        }
        const label = relative(time);
        if (badge.textContent !== label) badge.textContent = label;
        const exact = new Date(time).toLocaleString();
        badge.title = exact;
        badge.setAttribute('aria-label', `${options.timeField === 'created' ? 'Created' : options.timeField === 'updated' ? 'Updated' : 'Last activity'}: ${exact}`);
        badge.toggleAttribute('data-codex-mods-hover-actions', !!row.querySelector('[data-hover-card-open-immediately] button, [data-hover-card-open-immediately] [role="button"]'));
      }
      let legacyBadge = row.querySelector(legacySelector);
      if (!legacy) legacyBadge?.remove();
      else {
        if (!legacyBadge) {
          legacyBadge = document.createElement('span');
          legacyBadge.dataset.codexModsLegacy = 'sidebar-legacy';
          legacyBadge.textContent = archiveCopy.label;
        }
        const anchor = time != null ? badge : title;
        if (anchor) {
          if (anchor.nextSibling !== legacyBadge) container.insertBefore(legacyBadge, anchor.nextSibling);
        } else if (legacyBadge.parentElement !== container) {
          const trailing = container.lastElementChild;
          if (trailing && !trailing.matches(ownedBadgeSelector)) container.insertBefore(legacyBadge, trailing);
          else container.append(legacyBadge);
        }
        const explanation = archiveCopy.reason(recordBytes);
        const description = `${explanation} ${archiveCopy.history}\n${archiveCopy.lastMessage}: ${new Date(lastMessage).toLocaleString(language)}.\n${archiveCopy.action}`;
        legacyBadge.dataset.codexModsArchiveReason = reason;
        legacyBadge.title = description;
        legacyBadge.setAttribute('aria-label', `${archiveCopy.label}${chinese ? '。' : '. '}${description}`);
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
        if (sizeBadge.parentElement !== container || (title && (legacy ? legacyBadge : time == null ? title : badge).nextSibling !== sizeBadge)) {
          if (legacy) container.insertBefore(sizeBadge, legacyBadge.nextSibling);
          else if (time != null) container.insertBefore(sizeBadge, badge.nextSibling);
          else if (title) container.insertBefore(sizeBadge, title.nextSibling);
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
          const fill = Math.sqrt(Math.min(1, bytes / 1024 ** 3));
          row.style.setProperty('--codex-mods-fill', `${(fill * 100).toFixed(2)}%`);
          row.setAttribute('data-codex-mods-fill', '');
        }
      }
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
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'role', 'aria-busy', 'data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id', 'data-app-action-sidebar-thread-kind', 'data-thread-id', 'data-conversation-id', 'data-host-id', 'data-updated-at', 'data-recency-at', 'data-created-at'] });
  const timer = setInterval(refresh, options.refreshMs || 30000);
  const status = () => ({
    installed: !disposed,
    rows: rows().length,
    badges: document.querySelectorAll(badgeSelector).length,
    legacyBadges: document.querySelectorAll(legacySelector).length,
    activityRevision,
    activityEntries: Object.keys(lastMessages).length,
    localSessionIds: [...new Set(rows().map(rowIdentity).filter(isLocalSession).map(identity => identity.id.toLowerCase()))],
    sizeBadges: document.querySelectorAll(sizeSelector).length,
    sizeRevision,
    sizeEntries: Object.keys(sessionSizes).length,
    metadataEntries: entries.length,
    provider: source === 'none' && owned.size ? 'dom-attributes' : source,
    bootstrapAvailable: !!findBridge(),
    lastRefreshAt,
    activityProvider: options.showLegacy ? 'local-message-records' : null,
    warning: [lastError, sizeWarning, activityWarning].filter(Boolean).join(' ') || null,
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
  const setSessionActivity = (messages, warning = null, revision = 0) => {
    if (disposed) return;
    lastMessages = messages || {};
    activityWarning = warning;
    activityRevision = revision;
    render();
    return status();
  };
  w[key] = { status, dispose, refresh, setSessionSizes, setSessionActivity };
  return refresh().then(status);
}

export function payload(options) {
  return `(${sidebarTime.toString()})(${JSON.stringify(options)})`;
}

export const cleanupExpression = '(() => { globalThis.__codexModsSidebarTime?.dispose(); return { removed: !globalThis.__codexModsSidebarTime }; })()';
export const statusExpression = 'globalThis.__codexModsSidebarTime?.status() ?? null';
