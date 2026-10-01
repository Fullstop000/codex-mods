import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const stateDirectory = () => process.env.CODEX_PLUGINS_STATE_DIR || join(homedir(), '.codex-plugins');

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function readJSON(directory, name, fallback = null) {
  try { return JSON.parse(await readFile(join(directory, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJSON(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, name));
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function lock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, 'watcher.lock');
  const token = randomUUID();
  try { await writeFile(filename, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJSON(directory, 'watcher.lock');
    if (!Number.isInteger(previous?.pid) || previous.pid <= 0) throw new Error('Invalid watcher lock. Inspect ~/.codex-plugins/watcher.lock before removing it.');
    if (processAlive(previous.pid)) throw new Error('A watcher is already running. Run codex-plugins disable sidebar-time first, then wait for it to exit.');
    await unlink(filename);
    await writeFile(filename, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  }
  return async () => {
    const current = await readJSON(directory, 'watcher.lock');
    if (current?.token === token) await unlink(filename);
  };
}
