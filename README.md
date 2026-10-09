# Codex Mods

`codex-mods` adds runtime extensions to the Codex desktop app. Its first extension, `sidebar-time`, shows relative activity times beside sidebar threads.

Requires Node.js 22.6 or later.

## Install

```bash
npm install --global codex-mods
codex-mods --help
```

## Use

On macOS and Windows, quit and reopen the app with debugging enabled:

```bash
codex-mods enable sidebar-time --restart
```

Save active work before using `--restart`. Without it, the command connects to CDP or opens the app.

Keep this terminal open while the mod runs. Press Ctrl+C to remove the injected mod.

Check the connection with `codex-mods doctor`. To clean up the mod another way, run `codex-mods disable sidebar-time`.

Disabling the mod does not close the app's debugging port. To close that port, quit the app and reopen it from its usual launcher.

## Compatibility

Codex Mods is unofficial and experimental. It has been tested with Chromium fixtures; compatibility with the official Codex desktop app is unverified.

See `codex-mods --help` for available options.

## Publish

Run `npm login`, then `npm publish`. If using staged publishing, approve the release in npm's Staged Packages tab.

For later releases, configure an [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) for `Fullstop000/codex-mods`, workflow `publish.yml`, with direct publishing allowed. Push a `v<VERSION>` tag matching `package.json` to test and publish automatically.

Licensed under the [Apache License 2.0](LICENSE).
