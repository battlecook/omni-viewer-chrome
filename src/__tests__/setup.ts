/**
 * Jest test harness setup for the Chrome extension build.
 *
 * Responsibilities:
 *   - Provide a minimal `chrome.*` stub so modules that import / reference
 *     Chrome extension APIs (chrome.runtime.*, chrome.storage.*, etc.) do
 *     not crash when loaded by Jest in jsdom.
 *   - Provide a default `fetch` stub returning an empty Response so code
 *     that calls `fetch(chrome.runtime.getURL(...))` can run without
 *     hitting the real network. Tests are free to override per-case via
 *     `(global.fetch as jest.Mock).mockImplementationOnce(...)`.
 *
 * This file is wired in via `setupFilesAfterEnv` in jest.config.js, so it
 * runs once per test file after the test framework (jest globals) are
 * available.
 */

type AnyFn = (...args: unknown[]) => unknown;

interface ChromeEvent<T extends AnyFn = AnyFn> {
    addListener: jest.Mock<void, [T]>;
    removeListener: jest.Mock<void, [T]>;
    hasListener: jest.Mock<boolean, [T]>;
}

const makeEvent = <T extends AnyFn = AnyFn>(): ChromeEvent<T> => ({
    addListener: jest.fn(),
    removeListener: jest.fn(),
    hasListener: jest.fn().mockReturnValue(false),
});

const chromeStub = {
    runtime: {
        id: 'omni-viewer-test',
        getURL: jest.fn((path: string) => `chrome-extension://omni-viewer-test/${String(path).replace(/^\/+/, '')}`),
        sendMessage: jest.fn((..._args: unknown[]) => undefined),
        connect: jest.fn(() => ({
            name: 'test-port',
            postMessage: jest.fn(),
            disconnect: jest.fn(),
            onMessage: makeEvent(),
            onDisconnect: makeEvent(),
        })),
        onMessage: makeEvent(),
        onConnect: makeEvent(),
        onInstalled: makeEvent(),
        lastError: undefined as undefined | { message: string },
    },
    storage: {
        local: {
            get: jest.fn((_keys: unknown, cb?: (items: Record<string, unknown>) => void) => {
                if (typeof cb === 'function') {
                    cb({});
                }
                return Promise.resolve({});
            }),
            set: jest.fn((_items: Record<string, unknown>, cb?: () => void) => {
                if (typeof cb === 'function') {
                    cb();
                }
                return Promise.resolve();
            }),
            remove: jest.fn((_keys: unknown, cb?: () => void) => {
                if (typeof cb === 'function') {
                    cb();
                }
                return Promise.resolve();
            }),
            clear: jest.fn((cb?: () => void) => {
                if (typeof cb === 'function') {
                    cb();
                }
                return Promise.resolve();
            }),
        },
        session: {
            get: jest.fn(() => Promise.resolve({})),
            set: jest.fn(() => Promise.resolve()),
            remove: jest.fn(() => Promise.resolve()),
            clear: jest.fn(() => Promise.resolve()),
        },
        sync: {
            get: jest.fn(() => Promise.resolve({})),
            set: jest.fn(() => Promise.resolve()),
            remove: jest.fn(() => Promise.resolve()),
            clear: jest.fn(() => Promise.resolve()),
        },
        onChanged: makeEvent(),
    },
    tabs: {
        query: jest.fn(() => Promise.resolve([])),
        sendMessage: jest.fn(() => Promise.resolve(undefined)),
        create: jest.fn(() => Promise.resolve(undefined)),
        update: jest.fn(() => Promise.resolve(undefined)),
        onUpdated: makeEvent(),
    },
    action: {
        setBadgeText: jest.fn(() => Promise.resolve()),
        setBadgeBackgroundColor: jest.fn(() => Promise.resolve()),
        setIcon: jest.fn(() => Promise.resolve()),
        onClicked: makeEvent(),
    },
};

// Install the stub on the global / globalThis. Cast through `unknown` so we
// don't have to satisfy the full @types/chrome surface in test setup.
(globalThis as unknown as { chrome: typeof chromeStub }).chrome = chromeStub;

// --- fetch stub ---------------------------------------------------------
//
// Default response: an empty 200 OK Response. Individual tests can override
// the implementation as needed. We use jsdom's built-in Response /
// Request / Headers globals when available; otherwise we fall back to a
// minimal duck-typed object that satisfies most callers.

const ResponseCtor: typeof Response | undefined =
    typeof Response !== 'undefined' ? Response : undefined;

const buildEmptyResponse = (): Response => {
    if (ResponseCtor) {
        return new ResponseCtor('');
    }
    // jsdom always provides Response; this branch is a defensive fallback.
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: '',
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        blob: () => Promise.resolve(new Blob([])),
        headers: new Headers(),
        clone() {
            return this as unknown as Response;
        },
    } as unknown as Response;
};

const fetchMock = jest.fn(async (_input: unknown, _init?: unknown): Promise<Response> => {
    return buildEmptyResponse();
});

(globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

// --- Blob.prototype.arrayBuffer ----------------------------------------
//
// jsdom does not implement it, so viewer adapters that read a picked File's
// bytes (`new Uint8Array(await file.arrayBuffer())`) throw under Jest while
// working fine in Chrome. File extends Blob, so patching Blob covers both.

if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(this);
        });
    };
}

// Reset mocks between tests so leak-y state doesn't bleed across tests.
afterEach(() => {
    fetchMock.mockClear();
});
