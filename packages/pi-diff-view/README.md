# @bobrossthepainter/pi-diff-view

Pi extension that opens a native diff review window via `@bobrossthepainter/glimpse-relay-client`.

## Install

```bash
npm config set @bobrossthepainter:registry https://npm.pkg.github.com
pi install npm:@bobrossthepainter/pi-diff-view
```

Requires `@bobrossthepainter/glimpse-relay` running on the native macOS host when pi runs inside Docker.

## Commands

- `/diff-view`

The window lets you review `git diff`, last commit, historical commits, and all files; draft comments; then inserts the resulting review prompt into the pi editor.

## Container env

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
```
