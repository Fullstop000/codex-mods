const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function endpointURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('CDP endpoint must be a loopback HTTP origin, e.g. http://127.0.0.1:9222');
  }
  if (!url.port || Number(url.port) < 1024) throw new Error('Use an explicit CDP port between 1024 and 65535.');
  return url;
}

export function debuggerURL(value, endpoint) {
  const url = new URL(value);
  const origin = endpointURL(endpoint);
  if (url.protocol !== 'ws:' || !LOOPBACK.has(url.hostname) || url.port !== origin.port || url.username || url.password || url.search || url.hash || !/^\/devtools\/page\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new Error('Rejected a debugger URL outside the selected loopback CDP endpoint.');
  }
  return url.href;
}

export async function targets(endpoint, fixture = false) {
  const origin = endpointURL(endpoint);
  const response = await fetch(new URL('/json/list', origin), { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}.`);
  const list = await response.json();
  if (!Array.isArray(list)) throw new Error('Invalid CDP target list.');
  return list.filter((item) => {
    if (item.type !== 'page' || !item.webSocketDebuggerUrl || !/^[A-Za-z0-9._-]+$/.test(item.id)) return false;
    try {
      const page = new URL(item.url);
      const permitted = page.protocol === 'app:' || (fixture && page.protocol === 'http:' && LOOPBACK.has(page.hostname));
      if (!permitted) return false;
      debuggerURL(item.webSocketDebuggerUrl, endpoint);
      return true;
    } catch { return false; }
  });
}

export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextID = 1;
    socket.addEventListener('message', (event) => {
      let result;
      try { result = JSON.parse(event.data); } catch { return; }
      const waiter = this.pending.get(result.id);
      if (!waiter) return;
      this.pending.delete(result.id);
      clearTimeout(waiter.timer);
      if (result.error) waiter.reject(new Error(result.error.message));
      else waiter.resolve(result.result);
    });
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('CDP connection closed.'));
      }
      this.pending.clear();
    });
  }

  static async connect(target, endpoint) {
    const socket = new WebSocket(debuggerURL(target.webSocketDebuggerUrl, endpoint));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out.')); }, 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once: true });
    });
    return new CDP(socket);
  }

  send(method, params = {}, timeout = 5000) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection is not open.'));
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Renderer evaluation failed; run doctor to inspect compatibility.');
    return result.result?.value;
  }

  close() { this.socket.close(); }
}
