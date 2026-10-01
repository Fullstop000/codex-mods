#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { endpointURL } from './cdp.js';
import { doctor, enable, disable } from './runner.js';
import { readJSON, stateDirectory } from './state.js';

const help = `codex-plugins — local runtime extensions for the Codex desktop app

  codex-plugins doctor [--endpoint http://127.0.0.1:9222]
  codex-plugins enable sidebar-time [options]
  codex-plugins disable sidebar-time

Options:
  --endpoint URL       Loopback CDP origin (default: http://127.0.0.1:9222)
  --app PATH           Desktop app executable; auto-discovered on macOS/Windows
  --no-launch          Connect only; do not launch the desktop app
  --time-field FIELD   recency (default, fallback updated), updated, or created
  --threads-file PATH  Optional local JSON metadata snapshot for an adapter
  --row-selector CSS   Explicit row selector for a different app version
  --refresh-ms MS      Metadata/clock refresh interval (default: 30000)

Node >=22.6 is required. Enable runs in the foreground and reinjects on reload.
Fully quit an ordinary desktop instance before the first CDP launch.
No installation files, account settings, or thread names are changed.
`;

export function argumentsFor(args) {
  const parsed = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    endpoint: { type: 'string' }, app: { type: 'string' },
    'no-launch': { type: 'boolean' }, 'time-field': { type: 'string' },
    'threads-file': { type: 'string' }, 'row-selector': { type: 'string' },
    'refresh-ms': { type: 'string' }, fixture: { type: 'boolean' },
  } });
  const [command, plugin, ...extra] = parsed.positionals;
  if (extra.length) throw new Error('Unexpected positional arguments.');
  if (parsed.values.help || !command) return { help: true };
  if (!['enable', 'disable', 'doctor'].includes(command)) throw new Error('Unknown command. Use doctor, enable, or disable.');
  if (command === 'doctor' ? plugin != null : plugin !== 'sidebar-time') throw new Error('The available extension is sidebar-time.');
  const timeField = parsed.values['time-field'] || 'recency';
  if (!['recency', 'updated', 'created'].includes(timeField)) throw new Error('--time-field must be recency, updated, or created.');
  const refreshMs = Number(parsed.values['refresh-ms'] || 30000);
  if (!Number.isInteger(refreshMs) || refreshMs < 1000 || refreshMs > 3600000) throw new Error('--refresh-ms must be 1000–3600000.');
  const endpoint = parsed.values.endpoint || 'http://127.0.0.1:9222';
  endpointURL(endpoint);
  return { command, endpoint, endpointExplicit: !!parsed.values.endpoint, directory: stateDirectory(), app: parsed.values.app, noLaunch: !!parsed.values['no-launch'], timeField, rowSelector: parsed.values['row-selector'], refreshMs, threadsFile: parsed.values['threads-file'], fixture: !!parsed.values.fixture };
}

export async function main(args) {
  const options = argumentsFor(args);
  if (options.help) { console.log(help); return; }
  if (options.command === 'enable') return enable(options);
  if (options.command === 'disable') {
    const result = await disable(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.cleanupConfirmed) process.exitCode = 1;
    return;
  }
  const config = await readJSON(options.directory, 'config.json', {});
  if (!options.endpointExplicit && config.endpoint) options.endpoint = config.endpoint;
  const result = await doctor(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.compatibleTargets) process.exitCode = 1;
}

const isEntryPoint = () => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
};

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch(error => { console.error(`codex-plugins: ${error.message}`); process.exitCode = 1; });
}
