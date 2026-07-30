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
    show(options?: {
        title?: string;
    }): void;
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
/** Default loopback targets plus exact additional hostnames from GLIMPSE_RELAY_CLIENT_ALLOWED_HOSTS. */
export declare function getRelayClientAllowedHosts(): string[];
export declare function openGlimpseWindow(html: string, options?: GlimpseRelayOpenOptions): Promise<GlimpseRelayWindow>;
/**
 * Open a client-reachable HTTP(S) URL in host-side Glimpse.
 *
 * The host relay exposes a temporary loopback reverse proxy. HTTP, streaming
 * responses (including SSE), and WebSocket traffic are carried over the relay
 * and connected to the target by this client process.
 */
export declare function openRelayedUrl(url: string | URL, options?: GlimpseRelayOpenOptions): Promise<GlimpseRelayedUrl>;
export { openGlimpseWindow as open };
//# sourceMappingURL=index.d.ts.map