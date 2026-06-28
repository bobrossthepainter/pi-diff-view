import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import type { CursorAnchor, FollowMode, GlimpseInfo, GlimpseOpenOptions, GlimpseWindow } from "glimpseui";

const DEFAULT_CONTAINER_RELAY_HOST = "host.docker.internal";
const DEFAULT_LOCAL_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = 7777;
const DEFAULT_RELAY_TIMEOUT_MS = 2500;

export type GlimpseRelayOpenOptions = GlimpseOpenOptions;

export interface GlimpseRelayWindow {
  on(event: "ready", listener: (info: GlimpseInfo) => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "info", listener: (info: GlimpseInfo) => void): this;
  on(event: "closed", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "ready", listener: (info: GlimpseInfo) => void): this;
  once(event: "message", listener: (data: unknown) => void): this;
  once(event: "info", listener: (info: GlimpseInfo) => void): this;
  once(event: "closed", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "ready", listener: (info: GlimpseInfo) => void): this;
  removeListener(event: "message", listener: (data: unknown) => void): this;
  removeListener(event: "info", listener: (info: GlimpseInfo) => void): this;
  removeListener(event: "closed", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  send(js: string): void;
  setHTML(html: string): void;
  show(options?: { title?: string }): void;
  close(): void;
  loadFile(path: string): void;
  get info(): GlimpseInfo | null;
  getInfo(): void;
  followCursor(enabled: boolean, anchor?: CursorAnchor, mode?: FollowMode): void;
}

interface RelayConfig {
  host: string;
  port: number;
  token?: string;
  timeoutMs: number;
  source: string;
}

type RelayServerMessage =
  | { type: "opened" }
  | { type: "ready"; info: GlimpseInfo }
  | { type: "message"; data: unknown }
  | { type: "info"; info: GlimpseInfo }
  | { type: "closed" }
  | { type: "error"; message?: string; stack?: string };

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function relayEnvValue(name: "" | "_HOST" | "_PORT" | "_TIMEOUT_MS" | "_TOKEN" | "_TOKEN_FILE"): string | undefined {
  return envValue(
    `GLIMPSE_RELAY${name}`,
    `PI_DIFF_REVIEW_BRIDGE${name}`,
    `PI_DIFF_VIEW_BRIDGE${name}`,
  );
}

function tokenFromEnv(): string | undefined {
  const token = relayEnvValue("_TOKEN");
  if (token != null) return token;

  const tokenFile = relayEnvValue("_TOKEN_FILE");
  if (tokenFile == null) return undefined;

  try {
    const fileToken = readFileSync(tokenFile, "utf8").trim();
    return fileToken.length > 0 ? fileToken : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Glimpse relay token file '${tokenFile}': ${message}`);
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function parsePort(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value, fallback, "Glimpse relay port", 65535);
}

function isProbablyContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
}

function endpointFromValue(value: string, fallbackHost: string, fallbackPort: number): { host: string; port: number; token?: string } {
  const withScheme = value.includes("://") ? value : `tcp://${value}`;
  const parsed = new URL(withScheme);
  const host = parsed.hostname || fallbackHost;
  const port = parsed.port.length > 0 ? parsePort(parsed.port, fallbackPort) : fallbackPort;
  const token = parsed.searchParams.get("token") ?? undefined;
  return { host, port, token };
}

function getRelayConfig(): RelayConfig | null {
  const relayValue = relayEnvValue("");
  const relayBoolean = relayValue == null ? null : parseBoolean(relayValue);
  if (relayBoolean === false) return null;

  const runningInContainer = isProbablyContainer();
  const timeoutMs = parsePositiveInteger(
    relayEnvValue("_TIMEOUT_MS"),
    DEFAULT_RELAY_TIMEOUT_MS,
    "Glimpse relay timeout",
  );
  const fallbackHost = relayEnvValue("_HOST")
    ?? (runningInContainer ? DEFAULT_CONTAINER_RELAY_HOST : DEFAULT_LOCAL_RELAY_HOST);
  const fallbackPort = parsePort(relayEnvValue("_PORT"), DEFAULT_RELAY_PORT);
  const envToken = tokenFromEnv();

  if (relayValue != null && relayBoolean !== true) {
    const endpoint = endpointFromValue(relayValue, fallbackHost, fallbackPort);
    return {
      host: endpoint.host,
      port: endpoint.port,
      token: endpoint.token ?? envToken,
      timeoutMs,
      source: "GLIMPSE_RELAY",
    };
  }

  if (relayBoolean === true || runningInContainer) {
    return {
      host: fallbackHost,
      port: fallbackPort,
      token: envToken,
      timeoutMs,
      source: relayBoolean === true ? "GLIMPSE_RELAY" : "container auto-detect",
    };
  }

  return null;
}

function writeJsonLine(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function connectToRelay(config: RelayConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    socket.on("error", () => {});
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to Glimpse relay at ${config.host}:${config.port}`));
    }, config.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
    };

    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

class RemoteGlimpseWindow extends EventEmitter implements GlimpseRelayWindow {
  #socket: net.Socket;
  #buffer = "";
  #closed = false;
  #info: GlimpseInfo | null = null;

  constructor(socket: net.Socket) {
    super();
    this.#socket = socket;
    this.on("error", () => {});

    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("close", () => this.#emitClosed());
    socket.on("error", (error) => this.#emitError(error));
  }

  send(js: string): void {
    this.#write({ type: "send", js });
  }

  setHTML(html: string): void {
    this.#write({ type: "set-html", html });
  }

  show(options?: { title?: string }): void {
    this.#write({ type: "show", options });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#socket.destroyed) {
      this.#socket.end(`${JSON.stringify({ type: "close" })}\n`);
    }
    queueMicrotask(() => this.emit("closed"));
  }

  loadFile(path: string): void {
    this.#write({ type: "load-file", path });
  }

  get info(): GlimpseInfo | null {
    return this.#info;
  }

  getInfo(): void {
    this.#write({ type: "get-info" });
  }

  followCursor(enabled: boolean, anchor?: CursorAnchor, mode?: FollowMode): void {
    this.#write({ type: "follow-cursor", enabled, anchor, mode });
  }

  #write(message: unknown): void {
    if (this.#closed || this.#socket.destroyed) return;
    writeJsonLine(this.#socket, message);
  }

  #handleData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      let message: RelayServerMessage;
      try {
        message = JSON.parse(line) as RelayServerMessage;
      } catch (error) {
        this.#emitError(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: RelayServerMessage): void {
    if (message.type === "opened") {
      this.emit("relay-opened");
      return;
    }

    if (message.type === "ready") {
      this.#info = message.info;
      this.emit("ready", message.info);
      return;
    }

    if (message.type === "message") {
      this.emit("message", message.data);
      return;
    }

    if (message.type === "info") {
      this.#info = message.info;
      this.emit("info", message.info);
      return;
    }

    if (message.type === "closed") {
      this.#emitClosed();
      return;
    }

    if (message.type === "error") {
      const error = new Error(message.message ?? "Glimpse relay error");
      if (message.stack != null) error.stack = message.stack;
      this.#emitError(error);
    }
  }

  #emitClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("closed");
  }

  #emitError(error: Error): void {
    this.emit("error", error);
  }
}

async function openRemoteGlimpseWindow(html: string, options: GlimpseRelayOpenOptions, config: RelayConfig): Promise<GlimpseRelayWindow> {
  let socket: net.Socket;
  try {
    socket = await connectToRelay(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to Glimpse relay (${config.source}) at ${config.host}:${config.port}: ${message}`);
  }

  const window = new RemoteGlimpseWindow(socket);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out waiting for Glimpse relay to open a window at ${config.host}:${config.port}`));
    }, config.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      window.removeListener("relay-opened", onOpened);
      window.removeListener("error", onError);
      window.removeListener("closed", onClosed);
    };

    const onOpened = (): void => {
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onClosed = (): void => {
      cleanup();
      reject(new Error("Glimpse relay closed before opening a window."));
    };

    window.once("relay-opened", onOpened);
    window.once("error", onError);
    window.once("closed", onClosed);
    writeJsonLine(socket, { type: "open", token: config.token, html, options });
  });

  return window;
}

async function openNativeGlimpseWindow(html: string, options: GlimpseRelayOpenOptions): Promise<GlimpseRelayWindow> {
  let glimpse: typeof import("glimpseui");
  try {
    glimpse = await import("glimpseui");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load glimpseui locally: ${message}`);
  }
  return glimpse.open(html, options) as GlimpseWindow;
}

export async function openGlimpseWindow(html: string, options: GlimpseRelayOpenOptions = {}): Promise<GlimpseRelayWindow> {
  const relayConfig = getRelayConfig();
  if (relayConfig != null) {
    try {
      return await openRemoteGlimpseWindow(html, options, relayConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nStart the host relay on macOS, for example: glimpse-relay --docker, or set GLIMPSE_RELAY=0 to force local Glimpse.`);
    }
  }

  return openNativeGlimpseWindow(html, options);
}

export { openGlimpseWindow as open };
