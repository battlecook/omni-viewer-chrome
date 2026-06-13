/**
 * Shared message envelope used for both:
 *   (a) viewer-internal module-to-module dispatch (in-page) and
 *   (b) viewer ↔ background service worker (`chrome.runtime.sendMessage`).
 *
 * Ported from vscode-omni-viewer/src/utils/messageHandlers/types.ts.
 *
 * NOTE: Properties are intentionally permissive (`any`) for `data`/`blob` to
 * mirror the VSCode original. Stricter per-domain types live alongside each
 * handler.
 */
export interface WebviewMessage {
    /** Legacy field — equivalent to `type`. Kept for compatibility. */
    command: string;
    text?: string;
    data?: any;
    fileName?: string;
    blob?: any;
    imageData?: string;
    type?: string;
    lineNumber?: number;
    mimeType?: string;
    duration?: string;
    startTime?: string;
    endTime?: string;
    content?: string;
}

/**
 * Minimal "destination" abstraction used in place of vscode.Webview.
 *
 * In VSCode the host calls `webview.postMessage(...)` to push a message
 * down to the iframe. In Chrome MV3 we have two equivalents:
 *
 *   - From viewer page → background:  `chrome.runtime.sendMessage(msg)`
 *   - From background → viewer page:  `chrome.tabs.sendMessage(tabId, msg)`
 *     (or, for in-page module-to-module dispatch, `window.postMessage`)
 *
 * Handlers that need to reply use the abstraction below so call sites
 * don't have to know which channel is in play.
 */
export interface MessageTarget {
    postMessage(message: WebviewMessage): Promise<void> | void;
}

/** Disposable returned by message listener registration. */
export interface MessageDisposable {
    dispose(): void;
}
