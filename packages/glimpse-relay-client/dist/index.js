import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
const DEFAULT_CONTAINER_RELAY_HOST = "host.docker.internal";
const DEFAULT_LOCAL_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = 7777;
const DEFAULT_RELAY_TIMEOUT_MS = 2500;
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
    socket.write(`${JSON.stringify(message)}\n`);
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
class RemoteGlimpseWindow extends EventEmitter {
    #socket;
    #buffer = "";
    #closed = false;
    #info = null;
    constructor(socket) {
        super();
        this.#socket = socket;
        this.on("error", () => { });
        socket.on("data", (chunk) => this.#handleData(chunk));
        socket.on("close", () => this.#emitClosed());
        socket.on("error", (error) => this.#emitError(error));
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
            return;
        writeJsonLine(this.#socket, message);
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
        }
    }
    #emitClosed() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.emit("closed");
    }
    #emitError(error) {
        this.emit("error", error);
    }
}
async function openRemoteGlimpseWindow(html, options, config) {
    let socket;
    try {
        socket = await connectToRelay(config);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not connect to Glimpse relay (${config.source}) at ${config.host}:${config.port}: ${message}`);
    }
    const window = new RemoteGlimpseWindow(socket);
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
        writeJsonLine(socket, { type: "open", token: config.token, html, options });
    });
    return window;
}
export async function openGlimpseWindow(html, options = {}) {
    const relayConfig = getRelayConfig();
    try {
        return await openRemoteGlimpseWindow(html, options, relayConfig);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nStart the host relay first, for example: glimpse-relay install or glimpse-relay --docker.`);
    }
}
export { openGlimpseWindow as open };
//# sourceMappingURL=index.js.map