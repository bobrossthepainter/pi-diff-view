import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
const DEFAULT_CONTAINER_RELAY_HOST = "host.docker.internal";
const DEFAULT_LOCAL_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = 7777;
const DEFAULT_RELAY_TIMEOUT_MS = 2500;
const DEFAULT_ALLOWED_TARGET_HOSTS = ["localhost", "127.0.0.1"];
const ALLOWED_HOSTS_ENV = "GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS";
function parseBoolean(value) {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return null;
}
function envValue(name) {
    const value = process.env[name];
    return value != null && value.trim().length > 0 ? value.trim() : undefined;
}
function relayEnvValue(name) {
    return envValue(`GLIMPSE_RELAY${name}`);
}
function tokenFromEnv() {
    const token = relayEnvValue("_TOKEN");
    if (token != null)
        return token;
    const tokenFile = relayEnvValue("_TOKEN_FILE");
    if (tokenFile == null)
        return undefined;
    try {
        const fileToken = readFileSync(tokenFile, "utf8").trim();
        return fileToken.length > 0 ? fileToken : undefined;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read Glimpse relay token file '${tokenFile}': ${message}`);
    }
}
function parsePositiveInteger(value, fallback, label, max = Number.MAX_SAFE_INTEGER) {
    if (value == null)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return parsed;
}
function parsePort(value, fallback) {
    return parsePositiveInteger(value, fallback, "Glimpse relay port", 65535);
}
function normalizeHostname(hostname) {
    return hostname.trim().toLowerCase().replace(/\.$/, "");
}
/** Default loopback targets plus exact additional hostnames from GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS. */
export function getRelayClientAllowedHosts() {
    const hosts = new Set(DEFAULT_ALLOWED_TARGET_HOSTS);
    for (const entry of envValue(ALLOWED_HOSTS_ENV)?.split(",") ?? []) {
        const hostname = normalizeHostname(entry);
        if (hostname.length > 0)
            hosts.add(hostname);
    }
    return [...hosts];
}
function parseAndValidateTargetUrl(value) {
    let target;
    try {
        target = value instanceof URL ? new URL(value.href) : new URL(value);
    }
    catch {
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
        throw new Error(`Refusing to relay disallowed host '${target.hostname}'. Allowed hosts: ${allowedHosts.join(", ")}. ` +
            `Add exact hostnames with ${ALLOWED_HOSTS_ENV}=host1,host2.`);
    }
    return target;
}
function isProbablyContainer() {
    if (existsSync("/.dockerenv"))
        return true;
    try {
        const cgroup = readFileSync("/proc/1/cgroup", "utf8");
        return /docker|containerd|kubepods/i.test(cgroup);
    }
    catch {
        return false;
    }
}
function endpointFromValue(value, fallbackHost, fallbackPort) {
    const withScheme = value.includes("://") ? value : `tcp://${value}`;
    const parsed = new URL(withScheme);
    const host = parsed.hostname || fallbackHost;
    const port = parsed.port.length > 0 ? parsePort(parsed.port, fallbackPort) : fallbackPort;
    const token = parsed.searchParams.get("token") ?? undefined;
    return { host, port, token };
}
function getRelayConfig() {
    const relayValue = relayEnvValue("");
    const relayBoolean = relayValue == null ? null : parseBoolean(relayValue);
    if (relayBoolean === false) {
        throw new Error("Glimpse relay is disabled by GLIMPSE_RELAY=0.");
    }
    const runningInContainer = isProbablyContainer();
    const timeoutMs = parsePositiveInteger(relayEnvValue("_TIMEOUT_MS"), DEFAULT_RELAY_TIMEOUT_MS, "Glimpse relay timeout");
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
function writeJsonLine(socket, message) {
    if (socket.destroyed)
        return false;
    return socket.write(`${JSON.stringify(message)}\n`);
}
function connectToRelay(config) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: config.host, port: config.port });
        socket.on("error", () => { });
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            reject(new Error(`Timed out connecting to Glimpse relay at ${config.host}:${config.port}`));
        }, config.timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            socket.removeListener("connect", onConnect);
            socket.removeListener("error", onError);
        };
        const onConnect = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            socket.setNoDelay(true);
            resolve(socket);
        };
        const onError = (error) => {
            if (settled)
                return;
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
function forwardedHeaders(headers, target, proxyOrigin, upgrade = false) {
    const result = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (lower === "host" || (!upgrade && (HOP_BY_HOP_HEADERS.has(lower) || lower === "upgrade")))
            continue;
        result[name] = value;
    }
    result.host = target.host;
    const origin = result.origin;
    if (typeof origin === "string" && origin === proxyOrigin)
        result.origin = target.origin;
    const referer = result.referer;
    if (typeof referer === "string" && referer.startsWith(`${proxyOrigin}/`)) {
        result.referer = `${target.origin}${referer.slice(proxyOrigin.length)}`;
    }
    return result;
}
function responseHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined)
            result[name] = value;
    }
    return result;
}
function requestUrl(target, requestPath) {
    const resolved = new URL(requestPath, target.origin);
    if (resolved.origin !== target.origin) {
        throw new Error(`Refusing cross-origin proxy request to ${resolved.origin}`);
    }
    return resolved;
}
class RemoteGlimpseWindow extends EventEmitter {
    #socket;
    #buffer = "";
    #closed = false;
    #info = null;
    #target;
    #proxyUrl = null;
    #requests = new Map();
    #upgrades = new Map();
    constructor(socket, target) {
        super();
        this.#socket = socket;
        this.#target = target ?? null;
        this.on("error", () => { });
        socket.on("data", (chunk) => this.#handleData(chunk));
        socket.on("close", () => this.#emitClosed());
        socket.on("error", (error) => this.#emitError(error));
    }
    get targetUrl() {
        return this.#target?.href ?? "";
    }
    get proxyUrl() {
        return this.#proxyUrl;
    }
    send(js) {
        this.#write({ type: "send", js });
    }
    setHTML(html) {
        this.#write({ type: "set-html", html });
    }
    show(options) {
        this.#write({ type: "show", options });
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#destroyProxyConnections();
        if (!this.#socket.destroyed) {
            this.#socket.end(`${JSON.stringify({ type: "close" })}\n`);
        }
        queueMicrotask(() => this.emit("closed"));
    }
    loadFile(path) {
        this.#write({ type: "load-file", path });
    }
    get info() {
        return this.#info;
    }
    getInfo() {
        this.#write({ type: "get-info" });
    }
    followCursor(enabled, anchor, mode) {
        this.#write({ type: "follow-cursor", enabled, anchor, mode });
    }
    #write(message) {
        if (this.#closed || this.#socket.destroyed)
            return false;
        return writeJsonLine(this.#socket, message);
    }
    #handleData(chunk) {
        this.#buffer += chunk.toString("utf8");
        let newlineIndex;
        while ((newlineIndex = this.#buffer.indexOf("\n")) >= 0) {
            const line = this.#buffer.slice(0, newlineIndex);
            this.#buffer = this.#buffer.slice(newlineIndex + 1);
            if (line.trim().length === 0)
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch (error) {
                this.#emitError(error instanceof Error ? error : new Error(String(error)));
                continue;
            }
            this.#handleMessage(message);
        }
    }
    #handleMessage(message) {
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
            if (message.stack != null)
                error.stack = message.stack;
            this.#emitError(error);
            return;
        }
        try {
            if (message.type === "proxy-request")
                this.#startProxyRequest(message);
            else if (message.type === "proxy-request-data")
                this.#requests.get(message.id)?.request.write(Buffer.from(message.data, "base64"));
            else if (message.type === "proxy-request-end")
                this.#requests.get(message.id)?.request.end();
            else if (message.type === "proxy-request-abort")
                this.#abortProxyRequest(message.id);
            else if (message.type === "proxy-upgrade")
                this.#startProxyUpgrade(message);
            else if (message.type === "proxy-upgrade-data")
                this.#writeProxyUpgrade(message.id, Buffer.from(message.data, "base64"));
            else if (message.type === "proxy-upgrade-close")
                this.#closeProxyUpgrade(message.id);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const id = "id" in message ? message.id : undefined;
            if (id)
                this.#write({ type: "proxy-error", id, message: detail });
        }
    }
    #startProxyRequest(message) {
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
            response.on("data", (chunk) => {
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
    #startProxyUpgrade(message) {
        const target = this.#requireTarget();
        const url = requestUrl(target, message.url);
        const transport = target.protocol === "https:" ? https : http;
        const request = transport.request(url, {
            method: message.method,
            headers: forwardedHeaders(message.headers, target, message.proxyOrigin, true),
        });
        const pending = { request, queued: [] };
        this.#upgrades.set(message.id, pending);
        if (message.head)
            pending.queued.push(Buffer.from(message.head, "base64"));
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
            for (const chunk of pending.queued)
                socket.write(chunk);
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
    #writeProxyUpgrade(id, chunk) {
        const pending = this.#upgrades.get(id);
        if (!pending)
            return;
        if (pending.socket)
            pending.socket.write(chunk);
        else
            pending.queued.push(chunk);
    }
    #abortProxyRequest(id) {
        this.#requests.get(id)?.request.destroy();
        this.#requests.delete(id);
    }
    #closeProxyUpgrade(id) {
        const pending = this.#upgrades.get(id);
        pending?.socket?.destroy();
        pending?.request.destroy();
        this.#upgrades.delete(id);
    }
    #requireTarget() {
        if (!this.#target)
            throw new Error("No relayed target URL is configured.");
        return this.#target;
    }
    #destroyProxyConnections() {
        for (const pending of this.#requests.values())
            pending.request.destroy();
        this.#requests.clear();
        for (const pending of this.#upgrades.values()) {
            pending.socket?.destroy();
            pending.request.destroy();
        }
        this.#upgrades.clear();
    }
    #emitClosed() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#destroyProxyConnections();
        this.emit("closed");
    }
    #emitError(error) {
        this.emit("error", error);
    }
}
async function openRemoteGlimpseWindow(html, options, config, target) {
    let socket;
    try {
        socket = await connectToRelay(config);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not connect to Glimpse relay (${config.source}) at ${config.host}:${config.port}: ${message}`);
    }
    const window = new RemoteGlimpseWindow(socket, target);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            socket.destroy();
            reject(new Error(`Timed out waiting for Glimpse relay to open a window at ${config.host}:${config.port}`));
        }, config.timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            window.removeListener("relay-opened", onOpened);
            window.removeListener("error", onError);
            window.removeListener("closed", onClosed);
        };
        const onOpened = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onClosed = () => {
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
function withRelayHint(error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message}\nStart the host relay first, for example: glimpse-relay install or glimpse-relay --docker.`);
}
export async function openGlimpseWindow(html, options = {}) {
    const relayConfig = getRelayConfig();
    try {
        return await openRemoteGlimpseWindow(html, options, relayConfig);
    }
    catch (error) {
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
export async function openRelayedUrl(url, options = {}) {
    const target = parseAndValidateTargetUrl(url);
    const relayConfig = getRelayConfig();
    try {
        return await openRemoteGlimpseWindow("", options, relayConfig, target);
    }
    catch (error) {
        throw withRelayHint(error);
    }
}
export { openGlimpseWindow as open };
//# sourceMappingURL=index.js.map