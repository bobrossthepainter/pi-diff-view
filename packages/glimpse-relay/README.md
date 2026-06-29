# @bobrossthepainter/glimpse-relay

Host-side relay for opening native [Glimpse](https://github.com/hazat/glimpse) windows from Docker or VM clients.

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
