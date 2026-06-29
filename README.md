# pi-diff-view

Monorepo for native Glimpse UI relay support and the pi diff view extension.

## Origin and purpose

The `@bobrossthepainter/pi-diff-view` pi extension is based on Mario Zechner's original [`pi-diff-review`](https://github.com/badlogic/pi-diff-review). This repo takes over that idea and extends it with Glimpse UI support over a relay.

The adaptation is intended for users who run pi somewhere other than their native UI host — for example in Docker, a VM, or a remote environment — and want the native review window to appear on their local macOS host.

## Packages

- `@bobrossthepainter/glimpse-relay` — host-side CLI/LaunchAgent. Runs on native macOS and opens real Glimpse windows.
- `@bobrossthepainter/glimpse-relay-client` — pure Node client library for containerized tools/extensions.
- `@bobrossthepainter/pi-diff-view` — pi extension, adapted from Mario Zechner's original `pi-diff-review`, that uses the client library to show a native diff view UI from Docker/VM/remote pi sessions.

GitHub Packages registry mapping (also committed in `.npmrc` for repo-local commands):

```bash
npm config set @bobrossthepainter:registry https://npm.pkg.github.com
# if the packages are private, authenticate with a GitHub token that can read packages
npm login --scope=@bobrossthepainter --registry=https://npm.pkg.github.com
```

## Host setup on macOS

```bash
npm install -g @bobrossthepainter/glimpse-relay
# one-time auto-start setup
glimpse-relay install
```

This installs a user LaunchAgent (`dev.glimpse-relay`), generates `~/.glimpse-relay-token`, keeps the relay alive, and builds the Glimpse macOS host binary when needed.

Useful commands:

```bash
glimpse-relay status
glimpse-relay env
glimpse-relay uninstall
```

For local development from this repo, use:

```bash
npm install
npm run relay:install
```

## Container/pi setup

Use the env printed by `glimpse-relay env` / `npm run relay:env`, typically:

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
```

If that token file is not mounted in the container:

```bash
export GLIMPSE_RELAY_TOKEN="$(cat ~/.glimpse-relay-token)"
```

Install the pi extension after configuring npm to use GitHub Packages for the scope:

```bash
pi install npm:@bobrossthepainter/pi-diff-view
```

Then run `/diff-view` in pi.

## Development

```bash
npm install
npm run build
npm run check
```

## Publishing to GitHub Packages

Authenticate with GitHub Packages first, then:

```bash
npm run build
npm run publish:packages
```
