# @bobrossthepainter/pi-diff-view

Pi extension that opens a native diff review window via `@bobrossthepainter/glimpse-relay-client`.

## Origin and purpose

This package is based on Mario Zechner's original [`pi-diff-review`](https://github.com/badlogic/pi-diff-review) extension. This adaptation takes over that idea and extends it with Glimpse UI access over `glimpse-relay`.

The target audience is users who run pi somewhere other than the native host with UI access — for example inside Docker, a VM, or a remote environment — while still wanting the review window to appear on their local macOS host.

## Install

```bash
npm config set @bobrossthepainter:registry https://npm.pkg.github.com
pi install npm:@bobrossthepainter/pi-diff-view
```

Requires `@bobrossthepainter/glimpse-relay` running on the native macOS host when pi runs inside Docker, a VM, or another remote/headless environment.

## Commands

- `/diff-view`

The window lets you review `git diff`, last commit, historical commits, and all files; draft comments; then inserts the resulting review prompt into the pi editor.

## Container env

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
```
