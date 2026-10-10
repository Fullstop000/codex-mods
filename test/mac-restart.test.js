import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { restartMacApp } from '../src/launcher.js';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const appsScript = `ObjC.import('AppKit'); function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  var rows = [];
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    rows.push({path: ObjC.unwrap(app.bundleURL.path.stringByResolvingSymlinksInPath), pid: Number(app.processIdentifier), finished: Boolean(app.finishedLaunching)});
  }
  return JSON.stringify(rows);
}`;

test('native macOS quit affects the chosen bundle and handles a stopped app', { skip: process.platform !== 'darwin', timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mods-native-'));
  const fixtures = [];
  const bundleId = `com.fullstop.codexmods.fixture.${randomUUID()}`;
  try {
    const source = join(root, 'fixture.m');
    await writeFile(source, `#import <AppKit/AppKit.h>
@interface FixtureDelegate : NSObject <NSApplicationDelegate> @end
@implementation FixtureDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender { return NSTerminateNow; }
@end
int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    FixtureDelegate *delegate = [FixtureDelegate new];
    [app setDelegate:delegate];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1, 1)
      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    (void)window;
    // LaunchServices registers the bundle before AppKit has finished starting;
    // explicitly finish launch so NSRunningApplication.terminate reaches a ready event loop.
    [app finishLaunching];
    [app run];
  }
  return 0;
}
`);
    const fixtureExecutable = join(root, 'fixture');
    await execute('xcrun', ['clang', source, '-framework', 'AppKit', '-o', fixtureExecutable]);
    const executables = [];
    for (const name of ['Chosen App', 'Untouched']) {
      const bundle = join(root, `${name}.app`);
      const contents = join(bundle, 'Contents');
      const macos = join(contents, 'MacOS');
      await mkdir(macos, { recursive: true });
      const executable = join(macos, 'fixture');
      await copyFile(fixtureExecutable, executable);
      await chmod(executable, 0o755);
      await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`);
      executables.push(executable);
      fixtures.push({ bundle, executable });
      // -g prevents the temporary app from taking focus.
      await execute('open', ['-g', '-a', bundle]);
    }
    const runningFixtures = async () => {
      const { stdout } = await execute('osascript', ['-l', 'JavaScript', '-e', appsScript, bundleId]);
      return JSON.parse(stdout.trim() || '[]');
    };
    const deadline = Date.now() + 5000;
    let apps = [];
    for (;;) {
      apps = await runningFixtures();
      if (apps.length === 2 && fixtures.every(({ bundle }) => apps.some(app => app.path === bundle && app.finished))) break;
      assert(Date.now() < deadline, 'Disposable apps did not become ready');
      await delay(50);
    }
    for (const fixture of fixtures) fixture.pid = apps.find(app => app.path === fixture.bundle).pid;
    await restartMacApp(executables[0], 5000);
    const stoppedDeadline = Date.now() + 5000;
    while ((await runningFixtures()).some(app => app.path === fixtures[0].bundle)) {
      assert(Date.now() < stoppedDeadline, 'Selected app process did not exit');
      await delay(50);
    }
    assert((await runningFixtures()).some(app => app.path === fixtures[1].bundle), 'Untouched app must remain running');
    await restartMacApp(executables[0], 5000);
    assert.equal((await runningFixtures()).filter(app => app.path === fixtures[1].bundle).length, 1, 'Quitting a stopped bundle must preserve the other copy');
    await restartMacApp(executables[1], 5000);
    const secondStoppedDeadline = Date.now() + 5000;
    while ((await runningFixtures()).some(app => app.path === fixtures[1].bundle)) {
      assert(Date.now() < secondStoppedDeadline, 'Untouched app did not exit when selected');
      await delay(50);
    }
  } finally {
    try {
      const { stdout } = await execute('osascript', ['-l', 'JavaScript', '-e', appsScript, bundleId]);
      const running = JSON.parse(stdout.trim() || '[]');
      for (const fixture of fixtures) {
        const app = running.find(item => item.path === fixture.bundle);
        if (app && Number.isInteger(app.pid)) {
          try { process.kill(app.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
    } catch { /* Cleanup is limited to the exact disposable fixture bundle paths. */ }
    await rm(root, { recursive: true, force: true });
  }
});
