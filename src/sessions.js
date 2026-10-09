import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_FILE = new RegExp(`^rollout-.+-(${SESSION_ID})\\.jsonl$`, 'i');
const WARNING = 'Some session files could not be inspected; affected sizes were omitted.';

export async function readSessionSizes(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const filesBySession = new Map();
  const incompleteSessions = new Set();
  const seenFilesBySession = new Map();
  const directories = [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];
  let warning = false;
  let incompleteTree = false;

  while (directories.length) {
    const directory = directories.pop();
    let directoryInfo;
    try {
      directoryInfo = await lstat(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') warning = incompleteTree = true;
      continue;
    }
    if (!directoryInfo.isDirectory()) continue;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') warning = incompleteTree = true;
      continue;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const match = ROLLOUT_FILE.exec(entry.name);
      if (!match) continue;
      const sessionId = match[1].toLowerCase();
      try {
        const fileInfo = await lstat(path);
        if (!fileInfo.isFile()) continue;
        let seen = seenFilesBySession.get(sessionId);
        if (!seen) seenFilesBySession.set(sessionId, seen = new Set());
        const identity = `${fileInfo.dev}:${fileInfo.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        filesBySession.set(sessionId, (filesBySession.get(sessionId) || 0) + fileInfo.size);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          warning = true;
          incompleteSessions.add(sessionId);
        }
      }
    }
  }

  const sizes = {};
  if (!incompleteTree) {
    for (const [sessionId, size] of filesBySession) {
      if (!incompleteSessions.has(sessionId)) sizes[sessionId] = size;
    }
  }
  return { sizes, warning: warning ? WARNING : null };
}
