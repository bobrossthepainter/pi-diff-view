# @bobrossthepainter/glimpse-relay-client

Pure Node client for talking to `@bobrossthepainter/glimpse-relay`.

The client is general-purpose: it can open supplied HTML or relay any allowed HTTP(S) application reachable from its environment. Plannotator is one example consumer, not a required component. See the [technical architecture](../../docs/technical-architecture.md) for component, port, protocol, and lifecycle diagrams.

```ts
import { openGlimpseWindow } from "@bobrossthepainter/glimpse-relay-client";

const win = await openGlimpseWindow("<h1>Hello from Docker</h1>", {
  title: "Relay demo",
  width: 480,
  height: 320,
});

win.on("message", console.log);
win.send("document.body.style.color = 'white'");
```

## Relay a hosted URL

`openRelayedUrl()` opens a client-reachable HTTP(S) service in host-side Glimpse. The host relay creates a temporary loopback proxy, while HTTP requests, streaming responses such as SSE, and WebSocket connections are forwarded to the target by the client process.

```ts
import { openRelayedUrl } from "@bobrossthepainter/glimpse-relay-client";

const session = await openRelayedUrl("http://localhost:9000/welcome", {
  title: "Hosted app",
  width: 1280,
  height: 900,
});

session.on("closed", () => console.log("window closed"));
```

The package also installs a CLI. Install the client globally when another program needs to resolve it from `PATH`:

```bash
npm install -g @bobrossthepainter/glimpse-relay-client
glimpse-relay-open http://localhost:9000/welcome
```

Target hosts are denied unless explicitly allowed. `localhost` and `127.0.0.1` are always allowed. Add exact hostnames as a comma-separated list:

```bash
export GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS=google.com,bing.com
```

The URL supplies the target host, port, path, and query string. Only `http:` and `https:` targets are supported.

### Example: Plannotator

Plannotator passes its hosted URL to the executable configured by `PLANNOTATOR_BROWSER`. Configure the executable and the Plannotator server port separately:

```bash
export PLANNOTATOR_PORT=9000
export PLANNOTATOR_BROWSER="$(command -v glimpse-relay-open)"
```

Then commands such as `/plannotator-review` open through the relay. `PLANNOTATOR_BROWSER` must be an executable path; it should not contain the URL or shell arguments.

## Relay connection

Environment:

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
# or
export GLIMPSE_RELAY_TOKEN="..."
```

This package has no `glimpseui` dependency and does not open native windows by itself; the host relay must be running.
