import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { restartMacApp } from '../src/launcher.js';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native macOS quit affects the chosen bundle and handles a stopped app', { skip: process.platform !== 'darwin', timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mods-native-'));
  const children = [];
  try {
    const source = join(root, 'fixture.applescript');
    await writeFile(source, 'on idle\nreturn 1\nend idle\non quit\ncontinue quit\nend quit\n');
    const bundleId = `com.fullstop.codexmods.fixture.${randomUUID()}`;
    const executables = [];
    for (const name of ['Chosen App', 'Untouched']) {
      const bundle = join(root, `${name}.app`);
      await execute('osacompile', ['-s', '-o', bundle, source]);
      const plist = join(bundle, 'Contents/Info.plist');
      await execute('defaults', ['write', plist, 'CFBundleIdentifier', '-string', bundleId]);
      await execute('defaults', ['write', plist, 'LSUIElement', '-bool', 'YES']);
      const executable = join(bundle, 'Contents/MacOS/applet');
      executables.push(executable);
      const child = spawn(executable, [], { stdio: 'ignore' });
      const exited = new Promise((resolveExit, rejectExit) => {
        child.once('exit', resolveExit);
        child.once('error', rejectExit);
      });
      children.push({ child, exited });
    }
    const countScript = "ObjC.import('AppKit'); function run(argv) { return $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]).count; }";
    const deadline = Date.now() + 5000;
    for (;;) {
      const { stdout } = await execute('osascript', ['-l', 'JavaScript', '-e', countScript, bundleId]);
      if (Number(stdout.trim()) === 2) break;
      assert(Date.now() < deadline, 'Disposable apps did not become ready');
      await delay(50);
    }
    await restartMacApp(executables[0], 5000);
    await Promise.race([
      children[0].exited,
      delay(1000).then(() => { throw new Error('Selected app process did not exit'); }),
    ]);
    assert.equal(children[1].child.exitCode, null);
    assert.equal(children[1].child.signalCode, null);
    await restartMacApp(executables[0], 5000);
    const { stdout } = await execute('osascript', ['-l', 'JavaScript', '-e', countScript, bundleId]);
    assert.equal(Number(stdout.trim()), 1, 'Quitting a stopped bundle must preserve the other copy');
    await restartMacApp(executables[1], 5000);
    await children[1].exited;
  } finally {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
