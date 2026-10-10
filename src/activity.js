import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SESSION_ID, rolloutIdentity, resolveRolloutId } from './rollouts.js';

const INDEX_REFRESH_MS = 30_000;
const CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const INDEX_CHECK_MS = 1_000;
const WARNING = 'Some session activity could not be resolved; affected sessions were omitted.';
const NO_FOLLOW = constants.O_NOFOLLOW || 0;

function statSignature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs ?? BigInt(Math.trunc(stat.mtimeMs * 1e6))}`;
}

function asEpochMs(value, now) {
  let timestamp;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) timestamp = Number(trimmed);
    else timestamp = Date.parse(trimmed);
  } else return null;

  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < 100_000_000_000) timestamp *= 1000;
  return timestamp <= now ? timestamp : null;
}

function messageTimestamp(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { message: false };
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { message: false };

  const type = record.type;
  const payloadType = payload.type;
  const responseMessage = type === 'response_item' && payloadType === 'message' &&
    (payload.role === 'user' || payload.role === 'assistant');
  const eventMessage = type === 'event_msg' &&
    (payloadType === 'user_message' || payloadType === 'agent_message');
  if (!responseMessage && !eventMessage) return { message: false };

  const raw = record.timestamp ?? payload.timestamp;
  const timestamp = asEpochMs(raw, now);
  return timestamp == null ? { message: true, invalid: true } : { message: true, timestamp };
}

function parseLine(line, now) {
  let text = line.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { ok: true, message: false };
  let record;
  try { record = JSON.parse(text); }
  catch { return { ok: false }; }
  const result = messageTimestamp(record, now);
  if (result.invalid) return { ok: false, message: true };
  return { ok: true, ...result };
}

async function scanTail(handle, size, now) {
  let position = size;
  let scanned = 0;
  let carry = Buffer.alloc(0);

  while (position > 0 && scanned < MAX_TAIL_BYTES) {
    const length = Math.min(CHUNK_BYTES, position, MAX_TAIL_BYTES - scanned);
    position -= length;
    scanned += length;
    const chunk = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(chunk, offset, length - offset, position + offset);
      if (!result.bytesRead) return { unresolved: true };
      offset += result.bytesRead;
    }

    const joined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    const reachesStart = position === 0;
    let lineEnd = joined.length;

    // A final line without a newline is valid only if it parses as complete JSON.
    // JSON.parse below distinguishes that from an interrupted append.
    while (lineEnd > 0) {
      const newline = joined.lastIndexOf(0x0a, lineEnd - 1);
      const lineStart = newline + 1;

      if (lineStart === 0 && !reachesStart) {
        const includesDelimiter = lineEnd < joined.length && joined[lineEnd] === 0x0a;
        carry = joined.subarray(0, lineEnd + (includesDelimiter ? 1 : 0));
        break;
      }

      const outcome = parseLine(joined.subarray(lineStart, lineEnd), now);
      if (!outcome.ok) return { unresolved: true };
      if (outcome.message) return { timestamp: outcome.timestamp };
      lineEnd = newline;
      if (newline < 0) break;
    }

    if (reachesStart) return { unresolved: true };
    if (scanned >= MAX_TAIL_BYTES) break;
  }

  return { unresolved: true };
}

async function indexRollouts(codexHome) {
  const byId = new Map();
  const directorySignatures = new Map();
  let incomplete = false;
  const directories = [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];

  while (directories.length) {
    const directory = directories.pop();
    directorySignatures.set(directory, null);
    let directoryInfo;
    try { directoryInfo = await lstat(directory, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') incomplete = true;
      continue;
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      incomplete = true;
      continue;
    }
    directorySignatures.set(directory, statSignature(directoryInfo));

    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { incomplete = true; continue; }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { directories.push(path); continue; }
      if (!entry.isFile()) continue;

      const candidate = rolloutIdentity(entry.name);
      if (!candidate) continue;
      const unresolved = (info = null) => {
        for (const id of candidate.candidates) {
          let files = byId.get(id);
          if (!files) byId.set(id, files = []);
          files.push({ path, unreadable: true, signature: info ? statSignature(info) : null });
        }
      };

      let info;
      try {
        info = await lstat(path, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const id = await resolveRolloutId(path, candidate, info);
        if (!id) { unresolved(info); continue; }
        let files = byId.get(id);
        if (!files) byId.set(id, files = []);
        const identity = `${info.dev}:${info.ino}`;
        if (files.some(file => file.identity === identity)) continue;
        files.push({ path, identity });
      } catch (error) {
        if (error.code !== 'ENOENT') unresolved(info);
      }
    }
  }

  return { byId, incomplete, directorySignatures };
}

async function directoryIndexChanged(index) {
  const checks = await Promise.all([...index.directorySignatures].map(async ([path, signature]) => {
    try { return statSignature(await lstat(path, { bigint: true })) !== signature; }
    catch (error) { return error.code === 'ENOENT' && signature != null; }
  }));
  return checks.some(Boolean);
}

async function unresolvedRolloutsChanged(index, requested) {
  const files = new Map();
  for (const id of requested) {
    for (const file of index.byId.get(id) || []) {
      if (file.unreadable) files.set(file.path, file.signature);
    }
  }
  const checks = await Promise.all([...files].map(async ([path, signature]) => {
    try { return statSignature(await lstat(path, { bigint: true })) !== signature; }
    catch (error) { return error.code === 'ENOENT' && signature != null; }
  }));
  return checks.some(Boolean);
}

/**
 * Read the timestamp of the last user or assistant message for local sessions.
 * The reader indexes active and archived rollout names, then reads only bounded
 * tails for requested IDs. It never returns or logs message contents.
 */
export function createSessionActivityReader(codexHome) {
  codexHome ||= process.env.CODEX_HOME || join(homedir(), '.codex');
  let index = null;
  let indexAt = 0;
  let indexing = null;
  let lastIndexCheckAt = 0;
  const cache = new Map();

  async function rebuild() {
    if (indexing) return indexing;
    indexing = indexRollouts(codexHome).then(result => {
      index = result;
      indexAt = Date.now();
      lastIndexCheckAt = indexAt;
      const paths = new Set();
      for (const files of result.byId.values()) for (const file of files) paths.add(file.path);
      for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
      return result;
    }).finally(() => { indexing = null; });
    return indexing;
  }

  return async function read(ids, retryAfterMissing = true) {
    const requested = [...new Set(Array.from(ids || [], id => String(id).toLowerCase()).filter(id => new RegExp(`^${SESSION_ID}$`, 'i').test(id)))];
    if (!requested.length) return { lastMessages: {}, warning: null };
    if (!index || Date.now() - indexAt >= INDEX_REFRESH_MS) await rebuild();
    if (Date.now() - lastIndexCheckAt >= INDEX_CHECK_MS) {
      lastIndexCheckAt = Date.now();
      if (await directoryIndexChanged(index) || await unresolvedRolloutsChanged(index, requested)) await rebuild();
    }

    const lastMessages = {};
    let warning = Boolean(index.incomplete);
    if (index.incomplete) return { lastMessages, warning: WARNING };

    const now = Date.now();
    for (const id of requested) {
      const files = index.byId.get(id);
      if (!files?.length) continue;
      let latest = null;
      let unresolved = false;

      for (const file of files) {
        if (file.unreadable) { unresolved = true; break; }
        let info;
        try { info = await lstat(file.path, { bigint: true }); }
        catch (error) {
          if (error.code === 'ENOENT' && retryAfterMissing) {
            await rebuild();
            return read(requested, false);
          }
          unresolved = true;
          break;
        }
        if (!info.isFile() || info.isSymbolicLink()) { unresolved = true; break; }

        const signature = statSignature(info);
        let cached = cache.get(file.path);
        if (cached?.signature !== signature) {
          let handle;
          try {
            handle = await open(file.path, constants.O_RDONLY | NO_FOLLOW);
            const openedInfo = await handle.stat({ bigint: true });
            if (!openedInfo.isFile() || statSignature(openedInfo) !== signature) {
              unresolved = true;
              break;
            }
            const parsed = await scanTail(handle, Number(info.size), now);
            const afterInfo = await handle.stat({ bigint: true });
            if (statSignature(afterInfo) !== signature || parsed.unresolved) {
              cache.delete(file.path);
              unresolved = true;
              break;
            }
            cached = { signature, timestamp: parsed.timestamp };
            cache.set(file.path, cached);
          } catch {
            cache.delete(file.path);
            unresolved = true;
            break;
          } finally { await handle?.close().catch(() => {}); }
        }

        if (!Number.isFinite(cached.timestamp)) { unresolved = true; break; }
        latest = latest == null ? cached.timestamp : Math.max(latest, cached.timestamp);
      }

      if (unresolved || latest == null) warning = true;
      else lastMessages[id] = latest;
    }

    return { lastMessages, warning: warning ? WARNING : null };
  };
}
