# Codex Mods

`codex-mods` adds local session sizes and archive suggestions to the Codex desktop sidebar.

Requires Node.js 22.6 or later.

## Install

```bash
npm install --global codex-mods
codex-mods --help
```

## Use

On macOS and Windows, quit and reopen the app with debugging enabled:

```bash
codex-mods enable sidebar-size --show-legacy --restart
```

Show session record sizes with a subtle background fill:

```bash
codex-mods enable sidebar-size --restart
# Or show only archive suggestions:
codex-mods enable sidebar-legacy --restart
```

Sizes cover local rollout files in `sessions` and `archived_sessions`, excluding attachments and workspace files. Background fill uses a square-root scale capped at 1 GiB. Unknown and remote sizes are omitted. Use `--codex-home PATH` for a different data directory; sizes refresh every 30 seconds.

`Archive suggestion` marks local sessions only when their records exceed 100 MB (100,000,000 bytes) and they have no user or assistant messages for more than 48 hours. Running chats are excluded. Resumed records are included in sizes and activity. On hover, the suggestion disappears so you can use the chat's native Archive button. A new message clears the suggestion. Archiving keeps records saved and does not free disk space. Visible sessions are checked every second; sizes refresh every 30 seconds, including in suggestion-only mode. Unknown size or activity is omitted. Use `--locale zh-CN` for Chinese labels. Numerical times remain available through `sidebar-time`.

Save active work before using `--restart`. Without it, the command connects to CDP or opens the app.

Keep this terminal open while the mod runs. Press Ctrl+C to remove the injected mod.

Check the connection with `codex-mods doctor`. Run `codex-mods disable sidebar-size` to stop the watcher and remove its labels.

Disabling the mod does not close the app's debugging port. To close that port, quit the app and reopen it from its usual launcher.

## Compatibility

Codex Mods is unofficial and experimental. Sidebar components, themes and preload from Codex 26.1002.52244 pass isolated Chromium replay checks. Other app builds require an updated replay adapter.

From a source checkout, verify the installed app without restarting it or accessing your profile:

```bash
npm ci
npx playwright install chromium
npm run test:installed
```

The replay reads installed assets, uses synthetic data and blocks external requests. Screenshots and results are saved in `test-results/installed/`.

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
