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

Glimpse opens a real native window, so a Linux Docker container cannot draw it directly on macOS. Run the small bridge on the Mac host and let the pi extension in the container talk to it over TCP.

On the Mac host, from this package checkout/install:

```bash
npm install
export PI_DIFF_REVIEW_BRIDGE_TOKEN="$(openssl rand -hex 16)"
npm run bridge
# or: pi-diff-review-bridge --docker
```

Inside the container/persistent pi harness environment:

```bash
export PI_DIFF_REVIEW_BRIDGE=host.docker.internal:7777
export PI_DIFF_REVIEW_BRIDGE_TOKEN="<same token>"
```

Then run `/diff-view` or `/diff-review` in pi. The extension also auto-tries `host.docker.internal:7777` when it detects it is running in a container. Set `PI_DIFF_REVIEW_BRIDGE=0` to force local Glimpse instead.

For older env naming, `PI_DIFF_VIEW_BRIDGE*` aliases are also accepted.

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
