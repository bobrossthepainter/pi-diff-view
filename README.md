# pi-diff-review

This is pure slop, see: https://pi.dev/session/#d4ce533cedbd60040f2622dc3db950e2

It is my hope, that someone takes this idea and makes it gud.

Native diff review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/badlogic/pi-diff-review
```

## What it does

Adds `/diff-review` and `/diff-view` commands to pi.

The command:

1. opens a native review window
2. lets you switch between `git diff`, `last commit`, and `all files` scopes
3. shows a collapsible sidebar with fuzzy file search
4. shows git status markers in the sidebar for changed files and untracked files
5. lazy-loads file contents on demand as you switch files and scopes
6. lets you draft comments on the original side, modified side, or whole file
7. inserts the resulting feedback prompt into the pi editor when you submit

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window

## Docker on macOS

Glimpse opens a real native window, so a Linux Docker container cannot draw it directly on macOS. This package includes **glimpse-relay**, a small generic host relay that lets containerized code open Glimpse windows on the Mac host over TCP.

One-time setup on the Mac host, from this package checkout/install:

```bash
npm install
npm run relay:install
```

That installs a user LaunchAgent (`dev.glimpse-relay`) so the relay starts at login, keeps running, generates `~/.glimpse-relay-token`, and builds the Glimpse macOS host binary if needed.

Inside the container/persistent pi harness environment:

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
```

`npm run relay:install` prints the exact env lines for your machine.

If that host token file is not mounted in the container, use the token value instead:

```bash
export GLIMPSE_RELAY_TOKEN="$(cat ~/.glimpse-relay-token)"
```

Then run `/diff-view` or `/diff-review` in pi. The extension also auto-tries `host.docker.internal:7777` when it detects it is running in a container. Set `GLIMPSE_RELAY=0` to force local Glimpse instead.

Relay helpers:

```bash
npm run relay:status
npm run relay:env
npm run relay:uninstall
```

The old `bridge:*` scripts and `PI_DIFF_REVIEW_BRIDGE*` / `PI_DIFF_VIEW_BRIDGE*` env vars still work as aliases.

### Using glimpse-relay for other Glimpse UIs

The relay protocol is generic: clients send `open`, `send`, `set-html`, `show`, `load-file`, `get-info`, `follow-cursor`, and `close` JSON-lines messages; the host forwards Glimpse `ready`, `message`, `info`, `closed`, and `error` events back. The diff review window uses `src/glimpse-relay.ts`, which exposes a Glimpse-like `open()` / `openGlimpseWindow()` helper.

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
