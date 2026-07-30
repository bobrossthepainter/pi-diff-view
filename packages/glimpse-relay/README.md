# @bobrossthepainter/glimpse-relay

Host-side relay for opening native [Glimpse](https://github.com/hazat/glimpse) windows from Docker or VM clients.

The relay is application-agnostic. It supports supplied HTML and hosted web applications from any compatible relay client. See the [technical architecture](../../docs/technical-architecture.md) for component, port, protocol, and lifecycle diagrams.

## macOS host setup

Directly with `npx`:

```bash
npm config set @bobrossthepainter:registry https://npm.pkg.github.com
npx @bobrossthepainter/glimpse-relay install
```

Or install globally:

```bash
npm config set @bobrossthepainter:registry https://npm.pkg.github.com
npm install -g @bobrossthepainter/glimpse-relay
glimpse-relay install
```

Useful commands:

```bash
glimpse-relay status
glimpse-relay env
glimpse-relay uninstall
```

Run foreground server manually:

```bash
glimpse-relay --docker
```

The relay listens on port `7777` by default and accepts clients configured with:

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
```

In addition to opening supplied HTML, the relay supports `openRelayedUrl()` and the `glimpse-relay-open` CLI from `@bobrossthepainter/glimpse-relay-client`. For these sessions it creates an ephemeral proxy bound only to `127.0.0.1` on the host. HTTP, streaming/SSE, and WebSocket traffic is multiplexed over the authenticated client connection; the host relay does not connect to the target URL directly.
