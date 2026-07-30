import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import http, { type ClientRequest, type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_CONTAINER_RELAY_HOST = "host.docker.internal";
const DEFAULT_LOCAL_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = 7777;
const DEFAULT_RELAY_TIMEOUT_MS = 2500;
const DEFAULT_ALLOWED_TARGET_HOSTS = ["localhost", "127.0.0.1"] as const;
const ALLOWED_HOSTS_ENV = "GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS";

export type FollowMode = "snap" | "spring";
export type CursorAnchor = "top-left" | "top-right" | "right" | "bottom-right" | "bottom-left" | "left";

export interface GlimpseRelayOpenOptions {
  width?: number;
  height?: number;
  title?: string;
  x?: number;
  y?: number;
  frameless?: boolean;
  floating?: boolean;
  transparent?: boolean;
  clickThrough?: boolean;
  followCursor?: boolean;
  followMode?: FollowMode;
  cursorAnchor?: CursorAnchor;
  cursorOffset?: {
    x?: number;
    y?: number;
  };
  hidden?: boolean;
  autoClose?: boolean;
  timeout?: number;
}

export interface GlimpseScreenInfo {
  width: number;
  height: number;
  scaleFactor: number;
  visibleX?: number;
  visibleY?: number;
  visibleWidth?: number;
  visibleHeight?: number;
  x?: number;
  y?: number;
}

export interface GlimpseAppearanceInfo {
  darkMode: boolean;
  accentColor: string;
  reduceMotion: boolean;
  increaseContrast: boolean;
}

export interface GlimpseCursorInfo {
  x: number;
  y: number;
}

export interface GlimpseCursorTip {
  x: number;
  y: number;
}

export interface GlimpseInfo {
  screen: GlimpseScreenInfo;
  screens: GlimpseScreenInfo[];
  appearance: GlimpseAppearanceInfo;
  cursor: GlimpseCursorInfo;
  cursorTip: GlimpseCursorTip | null;
}

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

/** A Glimpse window whose page and same-origin network traffic are relayed to a client-side URL. */
export interface GlimpseRelayedUrl extends GlimpseRelayWindow {
  readonly targetUrl: string;
  readonly proxyUrl: string | null;
}

interface RelayConfig {
  host: string;
  port: number;
  token?: string;
  timeoutMs: number;
  source: string;
}

type ProxyHeaders = Record<string, string | string[] | undefined>;

type RelayServerMessage =
  | { type: "opened"; proxyUrl?: string }
  | { type: "ready"; info: GlimpseInfo }
  | { type: "message"; data: unknown }
  | { type: "info"; info: GlimpseInfo }
  | { type: "closed" }
  | { type: "error"; message?: string; stack?: string }
  | { type: "proxy-request"; id: string; method: string; url: string; headers: ProxyHeaders; proxyOrigin: string }
  | { type: "proxy-request-data"; id: string; data: string }
  | { type: "proxy-request-end"; id: string }
  | { type: "proxy-request-abort"; id: string }
  | { type: "proxy-upgrade"; id: string; method: string; url: string; headers: ProxyHeaders; proxyOrigin: string; head?: string }
  | { type: "proxy-upgrade-data"; id: string; data: string }
  | { type: "proxy-upgrade-close"; id: string };

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value != null && value.trim().length > 0 ? value.trim() : undefined;
}

function relayEnvValue(name: "" | "_HOST" | "_PORT" | "_TIMEOUT_MS" | "_TOKEN" | "_TOKEN_FILE"): string | undefined {
  return envValue(`GLIMPSE_RELAY${name}`);
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

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** Default loopback targets plus exact additional hostnames from GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS. */
export function getRelayClientAllowedHosts(): string[] {
  const hosts = new Set<string>(DEFAULT_ALLOWED_TARGET_HOSTS);
  for (const entry of envValue(ALLOWED_HOSTS_ENV)?.split(",") ?? []) {
    const hostname = normalizeHostname(entry);
    if (hostname.length > 0) hosts.add(hostname);
  }
  return [...hosts];
}

function parseAndValidateTargetUrl(value: string | URL): URL {
  let target: URL;
  try {
    target = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`Invalid relayed URL: ${String(value)}`);
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported relayed URL protocol '${target.protocol}'. Only http: and https: are supported.`);
  }
  if (target.username || target.password) {
    throw new Error("Relayed URLs must not contain embedded credentials.");
  }

  const hostname = normalizeHostname(target.hostname);
  const allowedHosts = getRelayClientAllowedHosts();
  if (!allowedHosts.includes(hostname)) {
    throw new Error(
      `Refusing to relay disallowed host '${target.hostname}'. Allowed hosts: ${allowedHosts.join(", ")}. ` +
      `Add exact hostnames with ${ALLOWED_HOSTS_ENV}=host1,host2.`,
    );
  }
  return target;
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

function getRelayConfig(): RelayConfig {
  const relayValue = relayEnvValue("");
  const relayBoolean = relayValue == null ? null : parseBoolean(relayValue);
  if (relayBoolean === false) {
    throw new Error("Glimpse relay is disabled by GLIMPSE_RELAY=0.");
  }

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

  return {
    host: fallbackHost,
    port: fallbackPort,
    token: envToken,
    timeoutMs,
    source: relayBoolean === true ? "GLIMPSE_RELAY" : runningInContainer ? "container auto-detect" : "default localhost",
  };
}

function writeJsonLine(socket: net.Socket, message: unknown): boolean {
  if (socket.destroyed) return false;
  return socket.write(`${JSON.stringify(message)}\n`);
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

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
]);

function forwardedHeaders(headers: ProxyHeaders, target: URL, proxyOrigin: string, upgrade = false): ProxyHeaders {
  const result: ProxyHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || (!upgrade && (HOP_BY_HOP_HEADERS.has(lower) || lower === "upgrade"))) continue;
    result[name] = value;
  }
  result.host = target.host;

  const origin = result.origin;
  if (typeof origin === "string" && origin === proxyOrigin) result.origin = target.origin;
  const referer = result.referer;
  if (typeof referer === "string" && referer.startsWith(`${proxyOrigin}/`)) {
    result.referer = `${target.origin}${referer.slice(proxyOrigin.length)}`;
  }
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): ProxyHeaders {
  const result: ProxyHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function requestUrl(target: URL, requestPath: string): URL {
  const resolved = new URL(requestPath, target.origin);
  if (resolved.origin !== target.origin) {
    throw new Error(`Refusing cross-origin proxy request to ${resolved.origin}`);
  }
  return resolved;
}

type PendingRequest = { request: ClientRequest };
type PendingUpgrade = { request: ClientRequest; socket?: net.Socket; queued: Buffer[] };

class RemoteGlimpseWindow extends EventEmitter implements GlimpseRelayedUrl {
  #socket: net.Socket;
  #buffer = "";
  #closed = false;
  #info: GlimpseInfo | null = null;
  #target: URL | null;
  #proxyUrl: string | null = null;
  #requests = new Map<string, PendingRequest>();
  #upgrades = new Map<string, PendingUpgrade>();

  constructor(socket: net.Socket, target?: URL) {
    super();
    this.#socket = socket;
    this.#target = target ?? null;
    this.on("error", () => {});

    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("close", () => this.#emitClosed());
    socket.on("error", (error) => this.#emitError(error));
  }

  get targetUrl(): string {
    return this.#target?.href ?? "";
  }

  get proxyUrl(): string | null {
    return this.#proxyUrl;
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
    this.#destroyProxyConnections();
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

  #write(message: unknown): boolean {
    if (this.#closed || this.#socket.destroyed) return false;
    return writeJsonLine(this.#socket, message);
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
      this.#proxyUrl = message.proxyUrl ?? null;
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
      return;
    }

    try {
      if (message.type === "proxy-request") this.#startProxyRequest(message);
      else if (message.type === "proxy-request-data") this.#requests.get(message.id)?.request.write(Buffer.from(message.data, "base64"));
      else if (message.type === "proxy-request-end") this.#requests.get(message.id)?.request.end();
      else if (message.type === "proxy-request-abort") this.#abortProxyRequest(message.id);
      else if (message.type === "proxy-upgrade") this.#startProxyUpgrade(message);
      else if (message.type === "proxy-upgrade-data") this.#writeProxyUpgrade(message.id, Buffer.from(message.data, "base64"));
      else if (message.type === "proxy-upgrade-close") this.#closeProxyUpgrade(message.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const id = "id" in message ? message.id : undefined;
      if (id) this.#write({ type: "proxy-error", id, message: detail });
    }
  }

  #startProxyRequest(message: Extract<RelayServerMessage, { type: "proxy-request" }>): void {
    const target = this.#requireTarget();
    const url = requestUrl(target, message.url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: message.method,
      headers: forwardedHeaders(message.headers, target, message.proxyOrigin),
    });
    this.#requests.set(message.id, { request });

    request.on("response", (response) => {
      this.#write({
        type: "proxy-response",
        id: message.id,
        statusCode: response.statusCode ?? 502,
        statusMessage: response.statusMessage,
        headers: responseHeaders(response.headers),
      });
      response.on("data", (chunk: Buffer) => {
        const writable = this.#write({ type: "proxy-response-data", id: message.id, data: chunk.toString("base64") });
        if (!writable) {
          response.pause();
          this.#socket.once("drain", () => response.resume());
        }
      });
      response.on("end", () => {
        this.#requests.delete(message.id);
        this.#write({ type: "proxy-response-end", id: message.id });
      });
      response.on("aborted", () => {
        this.#requests.delete(message.id);
        this.#write({ type: "proxy-error", id: message.id, message: "Target response was aborted." });
      });
    });
    request.on("error", (error) => {
      this.#requests.delete(message.id);
      this.#write({ type: "proxy-error", id: message.id, message: error.message });
    });
  }

  #startProxyUpgrade(message: Extract<RelayServerMessage, { type: "proxy-upgrade" }>): void {
    const target = this.#requireTarget();
    const url = requestUrl(target, message.url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: message.method,
      headers: forwardedHeaders(message.headers, target, message.proxyOrigin, true),
    });
    const pending: PendingUpgrade = { request, queued: [] };
    this.#upgrades.set(message.id, pending);
    if (message.head) pending.queued.push(Buffer.from(message.head, "base64"));

    request.on("upgrade", (response, socket, head) => {
      pending.socket = socket;
      this.#write({
        type: "proxy-upgrade-response",
        id: message.id,
        statusCode: response.statusCode ?? 101,
        statusMessage: response.statusMessage,
        headers: responseHeaders(response.headers),
        head: head.length > 0 ? head.toString("base64") : undefined,
      });
      for (const chunk of pending.queued) socket.write(chunk);
      pending.queued = [];
      socket.on("data", (chunk) => this.#write({ type: "proxy-upgrade-data", id: message.id, data: chunk.toString("base64") }));
      socket.on("close", () => {
        this.#upgrades.delete(message.id);
        this.#write({ type: "proxy-upgrade-close", id: message.id });
      });
      socket.on("error", (error) => this.#write({ type: "proxy-error", id: message.id, message: error.message }));
    });
    request.on("response", (response) => {
      response.resume();
      this.#upgrades.delete(message.id);
      this.#write({ type: "proxy-error", id: message.id, message: `Target refused WebSocket upgrade with HTTP ${response.statusCode ?? 500}.` });
    });
    request.on("error", (error) => {
      this.#upgrades.delete(message.id);
      this.#write({ type: "proxy-error", id: message.id, message: error.message });
    });
    request.end();
  }

  #writeProxyUpgrade(id: string, chunk: Buffer): void {
    const pending = this.#upgrades.get(id);
    if (!pending) return;
    if (pending.socket) pending.socket.write(chunk);
    else pending.queued.push(chunk);
  }

  #abortProxyRequest(id: string): void {
    this.#requests.get(id)?.request.destroy();
    this.#requests.delete(id);
  }

  #closeProxyUpgrade(id: string): void {
    const pending = this.#upgrades.get(id);
    pending?.socket?.destroy();
    pending?.request.destroy();
    this.#upgrades.delete(id);
  }

  #requireTarget(): URL {
    if (!this.#target) throw new Error("No relayed target URL is configured.");
    return this.#target;
  }

  #destroyProxyConnections(): void {
    for (const pending of this.#requests.values()) pending.request.destroy();
    this.#requests.clear();
    for (const pending of this.#upgrades.values()) {
      pending.socket?.destroy();
      pending.request.destroy();
    }
    this.#upgrades.clear();
  }

  #emitClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#destroyProxyConnections();
    this.emit("closed");
  }

  #emitError(error: Error): void {
    this.emit("error", error);
  }
}

async function openRemoteGlimpseWindow(
  html: string,
  options: GlimpseRelayOpenOptions,
  config: RelayConfig,
  target?: URL,
): Promise<RemoteGlimpseWindow> {
  let socket: net.Socket;
  try {
    socket = await connectToRelay(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to Glimpse relay (${config.source}) at ${config.host}:${config.port}: ${message}`);
  }

  const window = new RemoteGlimpseWindow(socket, target);

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
    writeJsonLine(socket, target
      ? { type: "open-url", token: config.token, url: target.href, options }
      : { type: "open", token: config.token, html, options });
  });

  return window;
}

function withRelayHint(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\nStart the host relay first, for example: glimpse-relay install or glimpse-relay --docker.`);
}

export async function openGlimpseWindow(html: string, options: GlimpseRelayOpenOptions = {}): Promise<GlimpseRelayWindow> {
  const relayConfig = getRelayConfig();
  try {
    return await openRemoteGlimpseWindow(html, options, relayConfig);
  } catch (error) {
    throw withRelayHint(error);
  }
}

/**
 * Open a client-reachable HTTP(S) URL in host-side Glimpse.
 *
 * The host relay exposes a temporary loopback reverse proxy. HTTP, streaming
 * responses (including SSE), and WebSocket traffic are carried over the relay
 * and connected to the target by this client process.
 */
export async function openRelayedUrl(
  url: string | URL,
  options: GlimpseRelayOpenOptions = {},
): Promise<GlimpseRelayedUrl> {
  const target = parseAndValidateTargetUrl(url);
  const relayConfig = getRelayConfig();
  try {
    return await openRemoteGlimpseWindow("", options, relayConfig, target);
  } catch (error) {
    throw withRelayHint(error);
  }
}

export { openGlimpseWindow as open };
