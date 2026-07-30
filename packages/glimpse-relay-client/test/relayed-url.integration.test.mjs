import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openRelayedUrl } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = resolve(here, "../../glimpse-relay/bin/glimpse-relay.mjs");
const fakeGlimpsePath = resolve(here, "fixtures/fake-glimpse-host.mjs");

function listen(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolvePromise(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function availablePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

function waitForRelay(child) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Relay startup timed out: ${output}`)), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("glimpse relay listening")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited during startup (${code}): ${output}`));
    });
    child.once("error", reject);
  });
}

function decodeWebSocketTextFrame(frame) {
  const length = frame[1] & 0x7f;
  const masked = (frame[1] & 0x80) !== 0;
  let offset = 2;
  if (length >= 126) throw new Error("Test only supports short WebSocket frames");
  const mask = masked ? frame.subarray(offset, offset + 4) : undefined;
  if (mask) offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return payload.toString("utf8");
}

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

test("openRelayedUrl forwards HTTP, SSE, and WebSocket traffic", { timeout: 15_000 }, async () => {
  const target = http.createServer((request, response) => {
    if (request.url === "/welcome?x=1") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`welcome:${request.url}:${request.headers.host}`);
      return;
    }
    if (request.url === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: second\n\n"), 25);
      return;
    }
    response.writeHead(404).end();
  });

  target.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"]; 
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.once("data", (frame) => {
      socket.write(encodeWebSocketTextFrame(`echo:${decodeWebSocketTextFrame(frame)}`));
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on("error", () => {});
  });

  const targetPort = await listen(target);
  const relayPort = await availablePort();
  const relay = spawn(process.execPath, [relayPath, "--host", "127.0.0.1", "--port", String(relayPort), "--token", "test-token"], {
    env: { ...process.env, GLIMPSE_BINARY_PATH: fakeGlimpsePath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const previous = {
    relay: process.env.GLIMPSE_RELAY,
    token: process.env.GLIMPSE_RELAY_TOKEN,
    timeout: process.env.GLIMPSE_RELAY_TIMEOUT_MS,
  };

  let session;
  try {
    await waitForRelay(relay);
    process.env.GLIMPSE_RELAY = `127.0.0.1:${relayPort}`;
    process.env.GLIMPSE_RELAY_TOKEN = "test-token";
    process.env.GLIMPSE_RELAY_TIMEOUT_MS = "5000";

    session = await openRelayedUrl(`http://localhost:${targetPort}/welcome?x=1`);
    assert.match(session.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+\/welcome\?x=1$/);

    const result = await new Promise((resolvePromise, reject) => {
      session.once("message", resolvePromise);
      session.once("error", reject);
    });
    assert.deepEqual(result, {
      page: `welcome:/welcome?x=1:localhost:${targetPort}`,
      stream: "data: first\n\ndata: second\n\n",
      webSocketResult: "echo:relay-ping",
    });
  } finally {
    session?.close();
    relay.kill("SIGTERM");
    await close(target);
    if (previous.relay == null) delete process.env.GLIMPSE_RELAY;
    else process.env.GLIMPSE_RELAY = previous.relay;
    if (previous.token == null) delete process.env.GLIMPSE_RELAY_TOKEN;
    else process.env.GLIMPSE_RELAY_TOKEN = previous.token;
    if (previous.timeout == null) delete process.env.GLIMPSE_RELAY_TIMEOUT_MS;
    else process.env.GLIMPSE_RELAY_TIMEOUT_MS = previous.timeout;
  }
});
