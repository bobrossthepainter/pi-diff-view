#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
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
  if (socket.destroyed) return false;
  return socket.write(`${JSON.stringify(message)}\n`);
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

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function proxyResponseHeaders(headers, targetOrigin, proxyOrigin, upgrade = false) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (!upgrade && HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "location" && typeof value === "string" && value.startsWith(targetOrigin)) {
      result[name] = `${proxyOrigin}${value.slice(targetOrigin.length)}`;
    } else if (lower === "access-control-allow-origin" && value === targetOrigin) {
      result[name] = proxyOrigin;
    } else {
      result[name] = value;
    }
  }
  return result;
}

function buildUrlWindowHtml(url) {
  const encoded = JSON.stringify(url).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Glimpse</title><style>html,body{width:100%;height:100%;margin:0;background:#fff}</style></head><body><script>location.replace(${encoded})</script></body></html>`;
}

function writeUpgradeResponse(socket, message, targetOrigin, proxyOrigin) {
  const statusCode = Number(message.statusCode) || 101;
  const statusMessage = typeof message.statusMessage === "string" ? message.statusMessage : "Switching Protocols";
  const headers = proxyResponseHeaders(message.headers, targetOrigin, proxyOrigin, true);
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (message.head) socket.write(Buffer.from(message.head, "base64"));
}

async function createWebProxy(relaySocket, target) {
  const responses = new Map();
  const upgrades = new Map();
  const connections = new Set();
  let proxyOrigin = "";

  const proxyServer = http.createServer((request, response) => {
    const id = randomUUID();
    responses.set(id, response);
    response.on("close", () => {
      if (!response.writableEnded) writeJsonLine(relaySocket, { type: "proxy-request-abort", id });
      responses.delete(id);
    });

    writeJsonLine(relaySocket, {
      type: "proxy-request",
      id,
      method: request.method || "GET",
      url: request.url || "/",
      headers: request.headers,
      proxyOrigin,
    });
    request.on("data", (chunk) => {
      const writable = writeJsonLine(relaySocket, { type: "proxy-request-data", id, data: chunk.toString("base64") });
      if (!writable) {
        request.pause();
        relaySocket.once("drain", () => request.resume());
      }
    });
    request.on("end", () => writeJsonLine(relaySocket, { type: "proxy-request-end", id }));
    request.on("aborted", () => writeJsonLine(relaySocket, { type: "proxy-request-abort", id }));
  });

  proxyServer.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });

  proxyServer.on("upgrade", (request, upgradeSocket, head) => {
    const id = randomUUID();
    upgrades.set(id, upgradeSocket);
    upgradeSocket.on("data", (chunk) => writeJsonLine(relaySocket, { type: "proxy-upgrade-data", id, data: chunk.toString("base64") }));
    upgradeSocket.on("close", () => {
      upgrades.delete(id);
      writeJsonLine(relaySocket, { type: "proxy-upgrade-close", id });
    });
    upgradeSocket.on("error", () => {});
    writeJsonLine(relaySocket, {
      type: "proxy-upgrade",
      id,
      method: request.method || "GET",
      url: request.url || "/",
      headers: request.headers,
      proxyOrigin,
      head: head.length > 0 ? head.toString("base64") : undefined,
    });
  });

  proxyServer.on("clientError", (_error, clientSocket) => clientSocket.destroy());

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      proxyServer.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      proxyServer.removeListener("error", onError);
      resolve();
    };
    proxyServer.once("error", onError);
    proxyServer.once("listening", onListening);
    proxyServer.listen(0, "127.0.0.1");
  });

  const address = proxyServer.address();
  if (address == null || typeof address === "string") throw new Error("Could not determine web proxy address.");
  proxyOrigin = `http://127.0.0.1:${address.port}`;
  const initialUrl = new URL(`${target.pathname}${target.search}`, proxyOrigin);
  initialUrl.hash = target.hash;

  return {
    initialUrl: initialUrl.href,
    handle(message) {
      const response = typeof message.id === "string" ? responses.get(message.id) : undefined;
      if (message.type === "proxy-response" && response) {
        const headers = proxyResponseHeaders(message.headers, target.origin, proxyOrigin);
        response.writeHead(Number(message.statusCode) || 502, message.statusMessage, headers);
        return true;
      }
      if (message.type === "proxy-response-data" && response) {
        response.write(Buffer.from(message.data, "base64"));
        return true;
      }
      if (message.type === "proxy-response-end" && response) {
        responses.delete(message.id);
        response.end();
        return true;
      }
      if (message.type === "proxy-upgrade-response") {
        const upgradeSocket = upgrades.get(message.id);
        if (!upgradeSocket) return true;
        writeUpgradeResponse(upgradeSocket, message, target.origin, proxyOrigin);
        return true;
      }
      if (message.type === "proxy-upgrade-data") {
        upgrades.get(message.id)?.write(Buffer.from(message.data, "base64"));
        return true;
      }
      if (message.type === "proxy-upgrade-close") {
        upgrades.get(message.id)?.destroy();
        upgrades.delete(message.id);
        return true;
      }
      if (message.type === "proxy-error" && typeof message.id === "string") {
        if (response) {
          responses.delete(message.id);
          if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end(`Glimpse relay proxy error: ${message.message || "unknown error"}`);
        }
        const upgradeSocket = upgrades.get(message.id);
        if (upgradeSocket) {
          if (!upgradeSocket.destroyed) upgradeSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          upgrades.delete(message.id);
        }
        return true;
      }
      return false;
    },
    close() {
      for (const response of responses.values()) response.destroy();
      responses.clear();
      for (const upgradeSocket of upgrades.values()) upgradeSocket.destroy();
      upgrades.clear();
      for (const connection of connections) connection.destroy();
      connections.clear();
      proxyServer.close();
    },
  };
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
  let webProxy = null;
  let opened = false;
  let authenticated = token.length === 0;
  let processing = Promise.resolve();

  const cleanup = () => {
    webProxy?.close();
    webProxy = null;
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

  const authenticateOpen = (message) => {
    if (opened) throw new Error("A relay connection can only open one window.");
    if (!authenticated) {
      if (message.token !== token) throw new Error("Invalid Glimpse relay token.");
      authenticated = true;
    }
  };

  const attachWindow = (win) => {
    windowRef = win;
    windows.add(win);
    win.on("ready", (info) => writeJsonLine(socket, { type: "ready", info }));
    win.on("message", (data) => writeJsonLine(socket, { type: "message", data }));
    win.on("info", (info) => writeJsonLine(socket, { type: "info", info }));
    win.on("closed", () => {
      windows.delete(win);
      if (windowRef === win) windowRef = null;
      webProxy?.close();
      webProxy = null;
      writeJsonLine(socket, { type: "closed" });
      socket.end();
    });
    win.on("error", (error) => writeJsonLine(socket, toErrorPayload(error)));
  };

  const requireWindow = () => {
    if (windowRef == null) throw new Error("No Glimpse relay window is open.");
    return windowRef;
  };

  const handleMessage = async (message) => {
    if (message == null || typeof message !== "object") throw new Error("Relay message must be an object.");

    if (message.type === "open") {
      authenticateOpen(message);
      if (typeof message.html !== "string") throw new Error("Open message requires an html string.");
      const options = message.options && typeof message.options === "object" ? message.options : {};
      const win = open(message.html, options);
      opened = true;
      attachWindow(win);
      writeJsonLine(socket, { type: "opened" });
      return;
    }

    if (message.type === "open-url") {
      authenticateOpen(message);
      if (typeof message.url !== "string") throw new Error("open-url message requires a url string.");
      const target = new URL(message.url);
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("open-url only supports http: and https: URLs.");
      webProxy = await createWebProxy(socket, target);
      const options = message.options && typeof message.options === "object" ? message.options : {};
      const win = open(buildUrlWindowHtml(webProxy.initialUrl), options);
      opened = true;
      attachWindow(win);
      writeJsonLine(socket, { type: "opened", proxyUrl: webProxy.initialUrl });
      return;
    }

    if (!authenticated) throw new Error("Relay client is not authenticated.");
    if (webProxy?.handle(message)) return;

    if (message.type === "send") {
      if (typeof message.js !== "string") throw new Error("Send message requires a js string.");
      requireWindow().send(message.js);
      return;
    }
    if (message.type === "set-html") {
      if (typeof message.html !== "string") throw new Error("set-html message requires an html string.");
      requireWindow().setHTML(message.html);
      return;
    }
    if (message.type === "show") {
      const options = message.options && typeof message.options === "object" ? message.options : undefined;
      requireWindow().show(options);
      return;
    }
    if (message.type === "load-file") {
      if (typeof message.path !== "string") throw new Error("load-file message requires a path string.");
      requireWindow().loadFile(message.path);
      return;
    }
    if (message.type === "get-info") {
      requireWindow().getInfo();
      return;
    }
    if (message.type === "follow-cursor") {
      requireWindow().followCursor(Boolean(message.enabled), message.anchor, message.mode);
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
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        sendErrorAndClose(error);
        cleanup();
        return;
      }
      processing = processing.then(() => handleMessage(message)).catch((error) => {
        sendErrorAndClose(error);
        cleanup();
      });
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
