import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, posix } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
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
    for (const root of (process.env.PATH || '').split(delimiter)) {
      if (root) candidates.push(join(root, 'codex-desktop'), join(root, 'chatgpt-desktop'));
    }
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('No desktop app executable found. Use --app <path-to-Codex-or-ChatGPT-executable>. Linux requires an existing desktop installation.');
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  throw error;
}

const delay = (ms, signal) => new Promise((resolveDelay, reject) => {
  throwIfAborted(signal);
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', aborted); resolveDelay(); }
  function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); try { throwIfAborted(signal); } catch (error) { reject(error); } }
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
});

async function awaitOrAbort(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => { try { throwIfAborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function bindAndClose(host, port) {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true, ipv6Only: host.includes(':') }, resolveListen);
  });
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export async function assertLoopbackPortFree(endpoint, bind = bindAndClose) {
  const origin = endpointURL(endpoint);
  const hosts = origin.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [origin.hostname === '[::1]' ? '::1' : origin.hostname];
  try {
    for (const host of hosts) await bind(host, Number(origin.port));
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(`CDP port ${origin.port} is still occupied after app shutdown; refusing to connect to or launch against another process.`);
    throw new Error(`Could not verify that CDP port ${origin.port} is free (${error.message}); refusing to launch.`);
  }
}

export function macAppBundle(executable) {
  const index = executable.indexOf('.app/Contents/MacOS/');
  if (index < 0) throw new Error('Safe restart on macOS requires an executable inside a .app bundle.');
  return executable.slice(0, index + 4);
}

async function macBundleId(executable, native = execute) {
  const bundle = macAppBundle(executable);
  const { stdout } = await native('defaults', ['read', posix.join(bundle, 'Contents/Info'), 'CFBundleIdentifier'], { timeout: 5000 });
  const id = stdout.trim();
  if (!/^[A-Za-z0-9.-]+$/.test(id)) throw new Error('Could not resolve a valid bundle identifier for the selected app.');
  return id;
}

const macQuitScript = `ObjC.import('AppKit');
function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  var wantedPath = ObjC.unwrap($.NSString.stringWithString(argv[1]).stringByResolvingSymlinksInPath);
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    if (ObjC.unwrap(app.bundleURL.path.stringByResolvingSymlinksInPath) !== wantedPath) continue;
    if (!app.terminate) throw new Error('The selected app refused the normal quit request.');
    return 'quit-requested';
  }
  return 'not-running';
}`;
const macIsRunningScript = `ObjC.import('AppKit');
function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  var wantedPath = ObjC.unwrap($.NSString.stringWithString(argv[1]).stringByResolvingSymlinksInPath);
  for (var i = 0; i < apps.count; i++) {
    if (ObjC.unwrap(apps.objectAtIndex(i).bundleURL.path.stringByResolvingSymlinksInPath) === wantedPath) return 'running';
  }
  return 'stopped';
}`;

export async function restartMacApp(executable, timeoutMs, native = execute, canonicalPath = realpath, signal) {
  throwIfAborted(signal);
  const bundle = await canonicalPath(macAppBundle(executable));
  throwIfAborted(signal);
  const bundleId = await macBundleId(executable, native);
  throwIfAborted(signal);
  const { stdout } = await native('osascript', ['-l', 'JavaScript', '-e', macQuitScript, bundleId, bundle], { timeout: 10000 });
  throwIfAborted(signal);
  const quitStatus = stdout.trim();
  if (quitStatus === 'not-running') return;
  if (quitStatus !== 'quit-requested') throw new Error(`Unexpected macOS quit status: ${quitStatus || '(empty)'}.`);
  await waitUntilStopped(async () => {
    const state = await native('osascript', ['-l', 'JavaScript', '-e', macIsRunningScript, bundleId, bundle], { timeout: 5000 });
    const status = state.stdout.trim();
    if (status !== 'running' && status !== 'stopped') throw new Error(`Unexpected macOS process status: ${status || '(empty)'}.`);
    return status === 'running';
  }, timeoutMs, signal);
}

const powershellProcessQuery = `$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:CODEX_MODS_RESTART_EXE)
$session = (Get-Process -Id $PID).SessionId
$current = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$found = @()
foreach ($item in Get-CimInstance Win32_Process) {
  if ($item.ExecutablePath -ne $target -or $item.SessionId -ne $session) { continue }
  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwner
  $ownerName = [string]$owner.Domain + [char]92 + [string]$owner.User
  if ($owner.ReturnValue -eq 0 -and $ownerName -eq $current) { $found += [int]$item.ProcessId }
}
ConvertTo-Json -Compress -InputObject $found`;
const powershellQuit = `$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:CODEX_MODS_RESTART_EXE)
$session = (Get-Process -Id $PID).SessionId
$current = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$found = @()
$closable = @()
foreach ($item in Get-CimInstance Win32_Process) {
  if ($item.ExecutablePath -ne $target -or $item.SessionId -ne $session) { continue }
  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwner
  $ownerName = [string]$owner.Domain + [char]92 + [string]$owner.User
  if ($owner.ReturnValue -ne 0 -or $ownerName -ne $current) { continue }
  $app = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if (-not $app) { continue }
  $found += [int]$item.ProcessId
  if ($app.MainWindowHandle -ne 0) { $closable += $app }
}
if ($found.Count -gt 0 -and $closable.Count -eq 0) { throw 'The selected app is running but has no closable main window.' }
foreach ($app in $closable) {
  if (-not $app.CloseMainWindow()) { throw "Selected app process $($app.Id) refused the normal close request." }
}
ConvertTo-Json -Compress -InputObject $found`;

async function windowsPids(executable) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellProcessQuery], {
    timeout: 10000, env: { ...process.env, CODEX_MODS_RESTART_EXE: executable },
  });
  const parsed = JSON.parse(stdout || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
}

async function windowsRestart(executable, timeoutMs, signal) {
  throwIfAborted(signal);
  const pids = await windowsPids(executable);
  throwIfAborted(signal);
  if (!pids.length) return;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellQuit], {
    timeout: 15000, env: { ...process.env, CODEX_MODS_RESTART_EXE: executable },
  });
  await waitUntilStopped(async () => (await windowsPids(executable)).length > 0, timeoutMs, signal);
}

async function waitUntilStopped(isRunning, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (!await awaitOrAbort(isRunning(), signal)) return;
    await delay(250, signal);
  }
  throw new Error('The selected app did not exit after a normal quit request; it was not relaunched.');
}

export async function restartSelectedApp(executable, options, platform = process.platform) {
  const timeoutMs = options.restartTimeoutMs ?? 10000;
  if (platform === 'darwin') return restartMacApp(executable, timeoutMs, execute, realpath, options.signal);
  if (platform === 'win32') return windowsRestart(executable, timeoutMs, options.signal);
  throw new Error(`Safe restart is supported on macOS and Windows; it is unsupported on ${platform}. The app was not launched.`);
}

async function startApp(executable, endpoint, deps = {}) {
  if (deps.startApp) return deps.startApp(executable, endpoint);
  const child = spawn(executable, launchArguments(endpoint), { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  child.unref();
}

export async function ensureEndpoint(options, log = () => {}, deps = {}) {
  const check = deps.targets ?? targets;
  const signal = options.signal;
  throwIfAborted(signal);
  if (options.restart) {
    if (options.noLaunch || options.fixture) throw new Error('--restart cannot be combined with --no-launch or --fixture.');
    const app = await (deps.findApp ?? findApp)(options.app);
    throwIfAborted(signal);
    await (deps.restartSelectedApp ?? restartSelectedApp)(app, options);
    throwIfAborted(signal);
    await (deps.assertPortFree ?? assertLoopbackPortFree)(options.endpoint);
    throwIfAborted(signal);
    log('Starting the installed desktop app with a loopback CDP port.');
    throwIfAborted(signal);
    await startApp(app, options.endpoint, deps);
  } else {
    try {
      await awaitOrAbort(check(options.endpoint, options.fixture), signal);
      throwIfAborted(signal);
      return;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throwIfAborted(signal);
      if (options.noLaunch || options.fixture) throw new Error(`CDP is unavailable: ${error.message}. Start the desktop app with a loopback debugging port.`);
    }
    const app = await (deps.findApp ?? findApp)(options.app);
    throwIfAborted(signal);
    log('Starting the installed desktop app with a loopback CDP port.');
    throwIfAborted(signal);
    await startApp(app, options.endpoint, deps);
  }

  const deadline = Date.now() + (options.startTimeoutMs ?? 30000);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      await awaitOrAbort(check(options.endpoint, options.fixture), signal);
      throwIfAborted(signal);
      return;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throwIfAborted(signal);
      await (deps.delay ?? delay)(deps.pollIntervalMs ?? 500, signal);
    }
  }
  throw new Error('The app did not expose CDP. This tool never force-quits the app, changes its profile, or disables its security settings.');
}
