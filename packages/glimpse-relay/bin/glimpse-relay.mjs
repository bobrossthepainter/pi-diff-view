#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 7777;
const LAUNCH_AGENT_COMMANDS = new Set(["install", "uninstall", "status", "env"]);

function runLaunchAgentCommand(args) {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "glimpse-relay-launch-agent.mjs");
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: "inherit" });
  if (result.error != null) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

if (LAUNCH_AGENT_COMMANDS.has(process.argv[2])) {
  runLaunchAgentCommand(process.argv.slice(2));
}

function printHelp() {
  console.log(`glimpse-relay

Runs a host-side Glimpse relay so processes in Docker/VMs can open native Glimpse windows on this machine.

Usage:
  glimpse-relay [--docker] [--host <address>] [--port <port>] [--token <token>]
  glimpse-relay install [--port <port>]
  glimpse-relay status
  glimpse-relay env
  glimpse-relay uninstall

Options:
  --docker              Bind 0.0.0.0 so Docker Desktop containers can connect via host.docker.internal.
  --host <address>     Bind address. Defaults to $GLIMPSE_RELAY_BIND or 127.0.0.1.
  --port <port>        Port. Defaults to $GLIMPSE_RELAY_PORT or 7777.
  --token <token>      Shared secret expected from clients. Also read from $GLIMPSE_RELAY_TOKEN.
  --token-file <path>  Read shared secret from a file. Also read from $GLIMPSE_RELAY_TOKEN_FILE.
  --help               Show this help.

Container-side environment:
  GLIMPSE_RELAY=host.docker.internal:7777
  GLIMPSE_RELAY_TOKEN=<same token>
  # or GLIMPSE_RELAY_TOKEN_FILE=/path/to/token-file
`);
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function relayEnvValue(name) {
  return envValue(`GLIMPSE_RELAY${name}`);
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

function readTokenFile(path) {
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token.length === 0) throw new Error("token file is empty");
    return token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Glimpse relay token file '${path}': ${message}`);
  }
}

function parseArgs(argv) {
  let host = relayEnvValue("_BIND") || "127.0.0.1";
  let port = parsePort(relayEnvValue("_PORT") || String(DEFAULT_PORT));
  let token = relayEnvValue("_TOKEN") || "";
  let tokenFile = relayEnvValue("_TOKEN_FILE") || "";

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
    if (arg === "--token-file") {
      tokenFile = readArgValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--token-file=")) {
      tokenFile = arg.slice("--token-file=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (token.length === 0 && tokenFile.length > 0) {
    token = readTokenFile(tokenFile);
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

  const requireWindow = () => {
    if (windowRef == null) throw new Error("No Glimpse relay window is open.");
    return windowRef;
  };

  const handleMessage = (message) => {
    if (message == null || typeof message !== "object") {
      throw new Error("Relay message must be an object.");
    }

    if (message.type === "open") {
      if (opened) throw new Error("A relay connection can only open one window.");
      if (!authenticated) {
        if (message.token !== token) {
          throw new Error("Invalid Glimpse relay token.");
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

      win.on("ready", (info) => writeJsonLine(socket, { type: "ready", info }));
      win.on("message", (data) => writeJsonLine(socket, { type: "message", data }));
      win.on("info", (info) => writeJsonLine(socket, { type: "info", info }));
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

    if (!authenticated) throw new Error("Relay client is not authenticated.");

    if (message.type === "send") {
      const win = requireWindow();
      if (typeof message.js !== "string") throw new Error("Send message requires a js string.");
      win.send(message.js);
      return;
    }

    if (message.type === "set-html") {
      const win = requireWindow();
      if (typeof message.html !== "string") throw new Error("set-html message requires an html string.");
      win.setHTML(message.html);
      return;
    }

    if (message.type === "show") {
      const win = requireWindow();
      const options = message.options && typeof message.options === "object" ? message.options : undefined;
      win.show(options);
      return;
    }

    if (message.type === "load-file") {
      const win = requireWindow();
      if (typeof message.path !== "string") throw new Error("load-file message requires a path string.");
      win.loadFile(message.path);
      return;
    }

    if (message.type === "get-info") {
      requireWindow().getInfo();
      return;
    }

    if (message.type === "follow-cursor") {
      const win = requireWindow();
      win.followCursor(Boolean(message.enabled), message.anchor, message.mode);
      return;
    }

    if (message.type === "close") {
      cleanup();
      writeJsonLine(socket, { type: "closed" });
      socket.end();
      return;
    }

    throw new Error(`Unknown relay message type: ${String(message.type)}`);
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
  console.log(`glimpse relay listening on ${host}:${port}`);
  if (host === "0.0.0.0" && token.length === 0) {
    console.warn("WARNING: relay is reachable from the network and no token is configured.");
  }
  if (token.length > 0) {
    console.log("relay token required; set GLIMPSE_RELAY_TOKEN or GLIMPSE_RELAY_TOKEN_FILE in the client/container.");
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
