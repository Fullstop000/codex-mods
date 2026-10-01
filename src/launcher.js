import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { endpointURL, targets } from './cdp.js';

const execute = promisify(execFile);
const exists = async (filename) => { try { await access(filename, constants.F_OK); return true; } catch { return false; } };

export function launchArguments(endpoint) {
  const url = endpointURL(endpoint);
  return [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${url.port}`];
}

export async function findApp(explicit) {
  if (explicit) {
    const filename = resolve(explicit);
    if (!await exists(filename)) throw new Error('The --app executable does not exist. Pass the app executable, not the .app directory or codex CLI.');
    return filename;
  }
  let candidates = [];
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')]) {
      candidates.push(join(root, 'ChatGPT.app/Contents/MacOS/ChatGPT'), join(root, 'Codex.app/Contents/MacOS/Codex'));
    }
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs/Codex/Codex.exe'));
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-AppxPackage | Where-Object { $_.Name -match "^OpenAI\\.(Codex|ChatGPT)$" } | Select-Object -ExpandProperty InstallLocation'], { timeout: 5000 });
      for (const root of stdout.trim().split(/\r?\n/).filter(Boolean)) {
        for (const relative of ['app/ChatGPT.exe', 'app/Codex.exe', 'ChatGPT.exe', 'Codex.exe', 'bin/Codex.exe']) candidates.push(join(root, relative));
      }
    } catch { /* Explicit --app remains available without PowerShell. */ }
  } else {
    for (const root of (process.env.PATH || '').split(':')) {
      if (root) candidates.push(join(root, 'codex-desktop'), join(root, 'chatgpt-desktop'));
    }
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('No desktop app executable found. Use --app <path-to-Codex-or-ChatGPT-executable>. Linux requires an existing desktop installation.');
}

export async function ensureEndpoint(options, log) {
  try { await targets(options.endpoint, options.fixture); return; } catch (error) {
    if (options.noLaunch || options.fixture) throw new Error(`CDP is unavailable: ${error.message}. Start the desktop app with a loopback debugging port.`);
  }
  const app = await findApp(options.app);
  log('Starting the installed desktop app with a loopback CDP port.');
  const child = spawn(app, launchArguments(options.endpoint), { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await targets(options.endpoint, options.fixture); return; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 500)); }
  }
  throw new Error('The app did not expose CDP. If it was already running, fully quit it and retry. This tool never force-quits the app, changes its profile, or disables its security settings.');
}
