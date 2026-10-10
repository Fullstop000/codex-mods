import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL = new RegExp(`^rollout-.+-(${SESSION_ID})\\.jsonl$`, 'i');
const RESUMED = new RegExp(`^rollout-.+-(${SESSION_ID})((?:_${SESSION_ID})+)\\.jsonl$`, 'i');
const MAX_HEADER_BYTES = 64 * 1024;

export function rolloutIdentity(name) {
  const resumed = RESUMED.exec(name);
  if (resumed) {
    const candidates = [resumed[1], ...resumed[2].slice(1).split('_')].map(id => id.toLowerCase());
    return { id: candidates[0], candidates: [...new Set(candidates)], suffixed: true };
  }
  const canonical = CANONICAL.exec(name);
  if (!canonical) return null;
  const id = canonical[1].toLowerCase();
  return { id, candidates: [id], suffixed: false };
}

// Resumed filenames include another UUID. The first metadata record, rather
// than the suffix, identifies the chat which owns the file.
export async function resolveRolloutId(path, identity, fileInfo) {
  if (!identity.suffixed) return identity.id;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (fileInfo && (String(stat.dev) !== String(fileInfo.dev) || String(stat.ino) !== String(fileInfo.ino)))) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES));
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) return null;
      offset += read.bytesRead;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline === -1 && stat.size > MAX_HEADER_BYTES) return null;
    let line = buffer.subarray(0, newline === -1 ? buffer.length : newline).toString('utf8');
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    let metadata;
    try { metadata = JSON.parse(line); } catch { return null; }
    const id = metadata?.type === 'session_meta' && typeof metadata.payload?.id === 'string' ? metadata.payload.id.toLowerCase() : null;
    return identity.candidates.includes(id) ? id : null;
  } finally { await handle.close(); }
}
