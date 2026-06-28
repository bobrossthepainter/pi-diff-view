# @bobrossthepainter/glimpse-relay-client

Pure Node client for talking to `@bobrossthepainter/glimpse-relay`.

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

Environment:

```bash
export GLIMPSE_RELAY=host.docker.internal:7777
export GLIMPSE_RELAY_TOKEN_FILE=/Users/<you>/.glimpse-relay-token
# or
export GLIMPSE_RELAY_TOKEN="..."
```

This package has no `glimpseui` dependency and does not open native windows by itself; the host relay must be running.
