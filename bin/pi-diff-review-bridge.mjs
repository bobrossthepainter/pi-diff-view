#!/usr/bin/env node
import net from "node:net";

const DEFAULT_PORT = 7777;

function printHelp() {
  console.log(`pi-diff-review-bridge

Runs the host-side Glimpse bridge used by /diff-review or /diff-view inside Docker.

Usage:
  pi-diff-review-bridge [--docker] [--host <address>] [--port <port>] [--token <token>]

Options:
  --docker           Bind 0.0.0.0 so Docker Desktop containers can connect via host.docker.internal.
  --host <address>  Bind address. Defaults to $PI_DIFF_REVIEW_BRIDGE_BIND or 127.0.0.1.
  --port <port>     Port. Defaults to $PI_DIFF_REVIEW_BRIDGE_PORT or 7777.
  --token <token>   Shared secret expected from clients. Also read from $PI_DIFF_REVIEW_BRIDGE_TOKEN.
  --help            Show this help.

Container-side environment:
  PI_DIFF_REVIEW_BRIDGE=host.docker.internal:7777
  PI_DIFF_REVIEW_BRIDGE_TOKEN=<same token>
`);
}

function readArgValue(args, index, flag) {
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseArgs(argv) {
  let host = process.env.PI_DIFF_REVIEW_BRIDGE_BIND || process.env.PI_DIFF_VIEW_BRIDGE_BIND || "127.0.0.1";
  let port = parsePort(process.env.PI_DIFF_REVIEW_BRIDGE_PORT || process.env.PI_DIFF_VIEW_BRIDGE_PORT || String(DEFAULT_PORT));
  let token = process.env.PI_DIFF_REVIEW_BRIDGE_TOKEN || process.env.PI_DIFF_VIEW_BRIDGE_TOKEN || "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--docker") {
      host = "0.0.0.0";
      continue;
    }
    if (arg === "--host") {
      host = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      port = parsePort(readArgValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--token") {
      token = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { host, port, token };
}

function writeJsonLine(socket, message) {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

function toErrorPayload(error) {
  if (error instanceof Error) {
    return { type: "error", message: error.message, stack: error.stack };
  }
  return { type: "error", message: String(error) };
}

function safeCloseWindow(win) {
  if (win == null) return;
  try {
    win.close();
  } catch {}
}

const { host, port, token } = parseArgs(process.argv.slice(2));
const { open } = await import("glimpseui").catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Could not load glimpseui on the host: ${message}`);
});
const windows = new Set();

const server = net.createServer((socket) => {
  socket.setNoDelay(true);

  let buffer = "";
  let windowRef = null;
  let opened = false;
  let authenticated = token.length === 0;

  const cleanup = () => {
    if (windowRef != null) {
      const win = windowRef;
      windowRef = null;
      windows.delete(win);
      safeCloseWindow(win);
    }
  };

  const sendErrorAndClose = (error) => {
    writeJsonLine(socket, toErrorPayload(error));
    socket.end();
  };

  const handleMessage = (message) => {
    if (message == null || typeof message !== "object") {
      throw new Error("Bridge message must be an object.");
    }

    if (message.type === "open") {
      if (opened) throw new Error("A bridge connection can only open one window.");
      if (!authenticated) {
        if (message.token !== token) {
          throw new Error("Invalid diff review bridge token.");
        }
        authenticated = true;
      }
      if (typeof message.html !== "string") {
        throw new Error("Open message requires an html string.");
      }

      const options = message.options && typeof message.options === "object" ? message.options : {};
      const win = open(message.html, options);
      windowRef = win;
      windows.add(win);
      opened = true;

      win.on("message", (data) => writeJsonLine(socket, { type: "message", data }));
      win.on("closed", () => {
        windows.delete(win);
        if (windowRef === win) windowRef = null;
        writeJsonLine(socket, { type: "closed" });
        socket.end();
      });
      win.on("error", (error) => writeJsonLine(socket, toErrorPayload(error)));

      writeJsonLine(socket, { type: "opened" });
      return;
    }

    if (!authenticated) throw new Error("Bridge client is not authenticated.");

    if (message.type === "send") {
      if (windowRef == null) throw new Error("No bridge window is open.");
      if (typeof message.js !== "string") throw new Error("Send message requires a js string.");
      windowRef.send(message.js);
      return;
    }

    if (message.type === "close") {
      cleanup();
      writeJsonLine(socket, { type: "closed" });
      socket.end();
      return;
    }

    throw new Error(`Unknown bridge message type: ${String(message.type)}`);
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        sendErrorAndClose(error);
        cleanup();
        return;
      }
    }
  });

  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

server.listen(port, host, () => {
  console.log(`pi diff review bridge listening on ${host}:${port}`);
  if (host === "0.0.0.0" && token.length === 0) {
    console.warn("WARNING: bridge is reachable from the network and no token is configured.");
  }
  if (token.length > 0) {
    console.log("bridge token required; set PI_DIFF_REVIEW_BRIDGE_TOKEN in the container.");
  }
});

function shutdown() {
  for (const win of windows) safeCloseWindow(win);
  windows.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
