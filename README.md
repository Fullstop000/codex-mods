# Codex Mods

`codex-mods` adds activity times and local session record sizes to the Codex desktop sidebar.

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

Show session record sizes with a subtle background fill:

```bash
codex-mods enable sidebar-size --restart
# Or show both time and size:
codex-mods enable sidebar-time --show-size --restart
```

Sizes cover local rollout files in `sessions` and `archived_sessions`, excluding attachments and workspace files. Background fill uses a logarithmic scale capped at 1 GiB. Unknown and remote sizes are omitted. Use `--codex-home PATH` for a different data directory; sizes refresh every 30 seconds.

Save active work before using `--restart`. Without it, the command connects to CDP or opens the app.

Keep this terminal open while the mod runs. Press Ctrl+C to remove the injected mod.

Check the connection with `codex-mods doctor`. To stop the current watcher and remove its labels, run `codex-mods disable sidebar-time` or `codex-mods disable sidebar-size`.

Disabling the mod does not close the app's debugging port. To close that port, quit the app and reopen it from its usual launcher.

## Compatibility

Codex Mods is unofficial and experimental. Sidebar components, themes and preload from Codex 26.1002.52244 pass isolated Chromium replay checks. Full desktop/backend integration remains unverified; time metadata comes from the app's initial sidebar snapshot.

From a source checkout, verify the installed app without restarting it or accessing your profile:

```bash
npm ci
npx playwright install chromium
npm run test:installed
```

The replay reads installed assets, uses synthetic data and blocks external requests. Screenshots and results are saved in `test-results/installed/`. Other app builds require an updated replay adapter.

See `codex-mods --help` for available options.

## Publish

Run `npm login`, then `npm publish`. If using staged publishing, approve the release in npm's Staged Packages tab.

Push a `v<VERSION>` tag matching `package.json` to run tests, publish to npm, and create a GitHub Release with generated notes and an installable `.tgz` package.

For npm automation, configure an [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) for `Fullstop000/codex-mods`, workflow `publish.yml`, with direct publishing allowed.

```bash
npm version patch
git push origin main --follow-tags
```

Licensed under the [Apache License 2.0](LICENSE).
