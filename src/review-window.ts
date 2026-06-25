import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import type { GlimpseOpenOptions, GlimpseWindow } from "glimpseui";

const DEFAULT_CONTAINER_BRIDGE_HOST = "host.docker.internal";
const DEFAULT_LOCAL_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 7777;
const DEFAULT_BRIDGE_TIMEOUT_MS = 2500;

export type ReviewWindowOptions = GlimpseOpenOptions;

export interface ReviewWindow {
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "closed", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "message", listener: (data: unknown) => void): this;
  removeListener(event: "closed", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  send(js: string): void;
  close(): void;
}

interface BridgeConfig {
  host: string;
  port: number;
  token?: string;
  timeoutMs: number;
  source: string;
}

type BridgeServerMessage =
  | { type: "opened" }
  | { type: "message"; data: unknown }
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

function parsePositiveInteger(value: string | undefined, fallback: number, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function parsePort(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value, fallback, "diff review bridge port", 65535);
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

function getBridgeConfig(): BridgeConfig | null {
  const bridgeValue = envValue("PI_DIFF_REVIEW_BRIDGE", "PI_DIFF_VIEW_BRIDGE");
  const bridgeBoolean = bridgeValue == null ? null : parseBoolean(bridgeValue);
  if (bridgeBoolean === false) return null;

  const runningInContainer = isProbablyContainer();
  const timeoutMs = parsePositiveInteger(
    envValue("PI_DIFF_REVIEW_BRIDGE_TIMEOUT_MS", "PI_DIFF_VIEW_BRIDGE_TIMEOUT_MS"),
    DEFAULT_BRIDGE_TIMEOUT_MS,
    "diff review bridge timeout",
  );
  const fallbackHost = envValue("PI_DIFF_REVIEW_BRIDGE_HOST", "PI_DIFF_VIEW_BRIDGE_HOST")
    ?? (runningInContainer ? DEFAULT_CONTAINER_BRIDGE_HOST : DEFAULT_LOCAL_BRIDGE_HOST);
  const fallbackPort = parsePort(envValue("PI_DIFF_REVIEW_BRIDGE_PORT", "PI_DIFF_VIEW_BRIDGE_PORT"), DEFAULT_BRIDGE_PORT);
  const envToken = envValue("PI_DIFF_REVIEW_BRIDGE_TOKEN", "PI_DIFF_VIEW_BRIDGE_TOKEN");

  if (bridgeValue != null && bridgeBoolean !== true) {
    const endpoint = endpointFromValue(bridgeValue, fallbackHost, fallbackPort);
    return {
      host: endpoint.host,
      port: endpoint.port,
      token: endpoint.token ?? envToken,
      timeoutMs,
      source: "PI_DIFF_REVIEW_BRIDGE",
    };
  }

  if (bridgeBoolean === true || runningInContainer) {
    return {
      host: fallbackHost,
      port: fallbackPort,
      token: envToken,
      timeoutMs,
      source: bridgeBoolean === true ? "PI_DIFF_REVIEW_BRIDGE" : "container auto-detect",
    };
  }

  return null;
}

function writeJsonLine(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function connectToBridge(config: BridgeConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    socket.on("error", () => {});
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to diff review bridge at ${config.host}:${config.port}`));
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

class RemoteReviewWindow extends EventEmitter implements ReviewWindow {
  #socket: net.Socket;
  #buffer = "";
  #closed = false;

  constructor(socket: net.Socket) {
    super();
    this.#socket = socket;
    this.on("error", () => {});

    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("close", () => this.#emitClosed());
    socket.on("error", (error) => this.#emitError(error));
  }

  send(js: string): void {
    if (this.#closed || this.#socket.destroyed) return;
    writeJsonLine(this.#socket, { type: "send", js });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#socket.destroyed) {
      this.#socket.end(`${JSON.stringify({ type: "close" })}\n`);
    }
    queueMicrotask(() => this.emit("closed"));
  }

  #handleData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      let message: BridgeServerMessage;
      try {
        message = JSON.parse(line) as BridgeServerMessage;
      } catch (error) {
        this.#emitError(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: BridgeServerMessage): void {
    if (message.type === "opened") {
      this.emit("bridge-opened");
      return;
    }

    if (message.type === "message") {
      this.emit("message", message.data);
      return;
    }

    if (message.type === "closed") {
      this.#emitClosed();
      return;
    }

    if (message.type === "error") {
      const error = new Error(message.message ?? "Diff review bridge error");
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

async function openRemoteReviewWindow(html: string, options: ReviewWindowOptions, config: BridgeConfig): Promise<ReviewWindow> {
  let socket: net.Socket;
  try {
    socket = await connectToBridge(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to diff review bridge (${config.source}) at ${config.host}:${config.port}: ${message}`);
  }

  const window = new RemoteReviewWindow(socket);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out waiting for diff review bridge to open a window at ${config.host}:${config.port}`));
    }, config.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      window.removeListener("bridge-opened", onOpened);
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
      reject(new Error("Diff review bridge closed before opening a window."));
    };

    window.once("bridge-opened", onOpened);
    window.once("error", onError);
    window.once("closed", onClosed);
    writeJsonLine(socket, { type: "open", token: config.token, html, options });
  });

  return window;
}

async function openNativeReviewWindow(html: string, options: ReviewWindowOptions): Promise<ReviewWindow> {
  let glimpse: typeof import("glimpseui");
  try {
    glimpse = await import("glimpseui");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load glimpseui locally: ${message}`);
  }
  return glimpse.open(html, options) as GlimpseWindow;
}

export async function openReviewWindow(html: string, options: ReviewWindowOptions): Promise<ReviewWindow> {
  const bridgeConfig = getBridgeConfig();
  if (bridgeConfig != null) {
    try {
      return await openRemoteReviewWindow(html, options, bridgeConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nStart the host bridge on macOS, for example: pi-diff-review-bridge --docker, or set PI_DIFF_REVIEW_BRIDGE=0 to force local Glimpse.`);
    }
  }

  return openNativeReviewWindow(html, options);
}
