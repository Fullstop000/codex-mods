# Codex Mods

`codex-mods` adds runtime extensions to the Codex desktop app. Its first extension, `sidebar-time`, shows relative activity times beside sidebar threads.

Requires Node.js 22.6 or later.

## Install

```bash
git clone https://github.com/Fullstop000/codex-mods.git
cd codex-mods
npm install --global .
codex-mods --help
```

## Use

Fully quit the Codex desktop app before enabling the mod.

```bash
codex-mods enable sidebar-time
```

Keep this terminal open while the mod runs. Press Ctrl+C to remove the injected mod.

Check the connection with `codex-mods doctor`. To clean up the mod another way, run `codex-mods disable sidebar-time`.

Disabling the mod does not close the app's debugging port. To close that port, quit the app and reopen it from its usual launcher.

## Compatibility

Codex Mods is unofficial and experimental. It has been tested with Chromium fixtures; compatibility with the official Codex desktop app is unverified.

See `codex-mods --help` for available options.

Licensed under the [Apache License 2.0](LICENSE).
