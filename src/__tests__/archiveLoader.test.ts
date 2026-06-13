/**
 * Unit tests for the libarchive worker bridge in
 * `templates/archive/js/archiveLoader.ts`.
 *
 * The real worker is the prebuilt libarchive.js bundle; spinning up a real
 * Web Worker in jsdom is impractical, so these tests use a `MockWorker` that
 * speaks just enough of the Comlink wire protocol to exercise the
 * request/response correlation:
 *
 *   - The mock buffers outgoing messages and lets the test replay any
 *     subset of replies (in any order) keyed by request id, so we verify
 *     that out-of-order responses are still resolved against the right
 *     outstanding promise.
 *   - We assert against the wire shape (`type`, `path`, `argumentList`) so
 *     drift in the protocol surfaces as a failing test rather than as a
 *     silent runtime failure when the real worker is loaded.
 */

// jsdom does not ship a MessageChannel implementation. The loader uses
// MessageChannel to serialize callable arguments (Comlink "proxy" handler);
// for tests we install a tiny polyfill that captures the messages on each
// port without ever wiring the two ports together — the loader's tests
// don't depend on the worker actually invoking the proxied callback.
class FakeMessagePort {
    public peer: FakeMessagePort | null = null;
    private listeners: Array<(event: MessageEvent) => void> = [];

    public postMessage(data?: unknown): void {
        const event = { data } as MessageEvent;
        for (const listener of [...(this.peer?.listeners ?? [])]) {
            listener(event);
        }
    }
    public addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
        this.listeners.push(listener);
    }
    public removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
        this.listeners = this.listeners.filter((item) => item !== listener);
    }
    public start(): void {
        /* noop */
    }
    public close(): void {
        /* noop */
    }
}
class FakeMessageChannel {
    public readonly port1: FakeMessagePort;
    public readonly port2: FakeMessagePort;

    constructor() {
        this.port1 = new FakeMessagePort();
        this.port2 = new FakeMessagePort();
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
    }
}
if (typeof (globalThis as { MessageChannel?: unknown }).MessageChannel === 'undefined') {
    (globalThis as unknown as { MessageChannel: typeof FakeMessageChannel }).MessageChannel =
        FakeMessageChannel;
}

import {
    createArchiveWorker,
    mapArchiveEntries,
    openArchive,
    wrapArchiveWorker,
} from '../templates/archive/js/archiveLoader';

// ---------------------------------------------------------------------------
// Mock worker
// ---------------------------------------------------------------------------

interface CapturedMessage {
    id: string;
    type: 'CONSTRUCT' | 'APPLY';
    path: string[];
    argumentList: Array<{ type: string; value?: unknown; name?: string }>;
}

class MockWorker {
    public readonly sent: CapturedMessage[] = [];
    private messageListeners: Array<(event: MessageEvent) => void> = [];
    private errorListeners: Array<(event: ErrorEvent) => void> = [];
    private messageErrorListeners: Array<(event: MessageEvent) => void> = [];
    public terminated = false;

    public postMessage(data: unknown, _transfer?: Transferable[]): void {
        this.sent.push(data as CapturedMessage);
    }

    public addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    public addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
    public addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
    public addEventListener(
        type: 'message' | 'error' | 'messageerror',
        listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void)
    ): void {
        if (type === 'message') {
            this.messageListeners.push(listener as (event: MessageEvent) => void);
        } else if (type === 'error') {
            this.errorListeners.push(listener as (event: ErrorEvent) => void);
        } else {
            this.messageErrorListeners.push(listener as (event: MessageEvent) => void);
        }
    }

    public removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    public removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
    public removeEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
    public removeEventListener(
        type: 'message' | 'error' | 'messageerror',
        listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void)
    ): void {
        if (type === 'message') {
            this.messageListeners = this.messageListeners.filter((l) => l !== listener);
        } else if (type === 'error') {
            this.errorListeners = this.errorListeners.filter((l) => l !== listener);
        } else {
            this.messageErrorListeners = this.messageErrorListeners.filter((l) => l !== listener);
        }
    }

    public terminate(): void {
        this.terminated = true;
    }

    /**
     * Helper: dispatch a fake reply to the listener registered for the given
     * outgoing message id.
     */
    public reply(id: string, value: unknown): void {
        const event = { data: { id, type: 'RAW', value } } as MessageEvent;
        // Snapshot the listener list so any handler that removes itself
        // during dispatch (the loader removes one listener per resolved
        // request) does not mutate the array we are iterating over.
        const snapshot = [...this.messageListeners];
        for (const listener of snapshot) listener(event);
    }

    public replyProxy(id: string, port: MockWorker): void {
        const event = {
            data: { id, type: 'HANDLER', name: 'proxy', value: port },
        } as MessageEvent;
        const snapshot = [...this.messageListeners];
        for (const listener of snapshot) listener(event);
    }
}

function invokeReadyCallback(message: CapturedMessage): void {
    const port = message.argumentList[0].value as FakeMessagePort | undefined;
    port?.postMessage({ id: `ready-${message.id}`, type: 'APPLY', path: [], argumentList: [] });
}

function invokeOpenCallback(message: CapturedMessage): void {
    const port = message.argumentList[1].value as FakeMessagePort | undefined;
    port?.postMessage({ id: `open-${message.id}`, type: 'APPLY', path: [], argumentList: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('archiveLoader.wrapArchiveWorker', () => {
    it('correlates replies to requests by id', async () => {
        const worker = new MockWorker();
        const proxy = wrapArchiveWorker(worker);

        const constructPromise = proxy.construct();
        expect(worker.sent).toHaveLength(1);
        expect(worker.sent[0].type).toBe('CONSTRUCT');
        expect(worker.sent[0].path).toEqual([]);
        // The constructor's readyCallback is serialized as a "proxy" handler.
        expect(worker.sent[0].argumentList[0].type).toBe('HANDLER');
        expect(worker.sent[0].argumentList[0].name).toBe('proxy');

        worker.reply(worker.sent[0].id, undefined);
        invokeReadyCallback(worker.sent[0]);
        await constructPromise;
    });

    it('issues APPLY for method calls and resolves the matching reply', async () => {
        const worker = new MockWorker();
        const proxy = wrapArchiveWorker(worker);

        // Skip CONSTRUCT bookkeeping by replying immediately.
        const cp = proxy.construct();
        worker.reply(worker.sent[0].id, undefined);
        invokeReadyCallback(worker.sent[0]);
        await cp;

        const listPromise = proxy.listFiles();
        const listMessage = worker.sent[1];
        expect(listMessage.type).toBe('APPLY');
        expect(listMessage.path).toEqual(['listFiles']);
        const fakeEntries = [
            { path: 'a.txt', size: 5, type: 'FILE' },
            { path: 'dir/', size: 0, type: 'DIR' },
        ];
        worker.reply(listMessage.id, fakeEntries);
        await expect(listPromise).resolves.toEqual(fakeEntries);
    });

    it('routes APPLY calls through the proxy port returned by CONSTRUCT', async () => {
        const worker = new MockWorker();
        const instancePort = new MockWorker();
        const proxy = wrapArchiveWorker(worker);

        const constructPromise = proxy.construct();
        worker.replyProxy(worker.sent[0].id, instancePort);
        invokeReadyCallback(worker.sent[0]);
        await constructPromise;

        const listPromise = proxy.listFiles();
        expect(worker.sent).toHaveLength(1);
        expect(instancePort.sent).toHaveLength(1);
        expect(instancePort.sent[0].type).toBe('APPLY');
        expect(instancePort.sent[0].path).toEqual(['listFiles']);

        instancePort.reply(instancePort.sent[0].id, [{ path: 'inside.txt', size: 4, type: 'FILE' }]);
        await expect(listPromise).resolves.toEqual([{ path: 'inside.txt', size: 4, type: 'FILE' }]);
    });

    it('resolves out-of-order replies against the right outstanding request', async () => {
        const worker = new MockWorker();
        const proxy = wrapArchiveWorker(worker);
        await dummyConstruct(proxy, worker);

        const a = proxy.listFiles();
        const b = proxy.hasEncryptedData();
        const idA = worker.sent[1].id;
        const idB = worker.sent[2].id;

        // Reply to B first.
        worker.reply(idB, true);
        worker.reply(idA, [{ path: 'x', size: 0, type: 'FILE' }]);

        await expect(b).resolves.toBe(true);
        await expect(a).resolves.toEqual([{ path: 'x', size: 0, type: 'FILE' }]);
    });

    it('maps thrown worker replies into a rejected promise', async () => {
        const worker = new MockWorker();
        const proxy = wrapArchiveWorker(worker);
        const cp = proxy.construct();
        worker.reply(worker.sent[0].id, undefined);
        invokeReadyCallback(worker.sent[0]);
        await cp;

        const openPromise = proxy.open(makeFakeFile(new Uint8Array(8), 'broken.zip'));
        // Simulate the Comlink "throw" handler reply shape that the loader
        // surfaces as Error.
        const id = worker.sent[1].id;
        for (const listener of [...listenersOf(worker)]) {
            listener({ data: { id, type: 'HANDLER', name: 'throw', value: { isError: true, value: { message: 'corrupt archive', name: 'Error' } } } } as MessageEvent);
        }
        await expect(openPromise).rejects.toThrow('corrupt archive');
    });

    it('passes the File to open() and waits for its completion callback', async () => {
        const worker = new MockWorker();
        const proxy = wrapArchiveWorker(worker);
        await dummyConstruct(proxy, worker);
        const file = makeFakeFile(new Uint8Array([1, 2, 3]), 'sample.zip');

        let completed = false;
        const openPromise = proxy.open(file).then(() => {
            completed = true;
        });
        const openMessage = worker.sent[1];
        expect(openMessage.path).toEqual(['open']);
        expect(openMessage.argumentList[0]).toEqual({ type: 'RAW', value: file });

        worker.reply(openMessage.id, undefined);
        await flushMicrotasks();
        expect(completed).toBe(false);

        invokeOpenCallback(openMessage);
        await openPromise;
        expect(completed).toBe(true);
    });

    it('terminates the underlying worker on close()', () => {
        const worker = new MockWorker();
        const proxy = wrapArchiveWorker(worker);
        proxy.terminate();
        expect(worker.terminated).toBe(true);
    });
});

describe('archiveLoader.createArchiveWorker', () => {
    it('starts the vendored libarchive bundle as a module worker', () => {
        const OriginalWorker = (globalThis as { Worker?: unknown }).Worker;
        const calls: Array<{ url: string; options?: WorkerOptions }> = [];
        class FakeWorker {
            constructor(url: string, options?: WorkerOptions) {
                calls.push({ url, options });
            }
        }
        (globalThis as unknown as { Worker: typeof FakeWorker }).Worker = FakeWorker;

        try {
            createArchiveWorker('chrome-extension://id/vendor/libarchive-worker-bundle.js');
            expect(calls).toEqual([
                {
                    url: 'chrome-extension://id/vendor/libarchive-worker-bundle.js',
                    options: { type: 'module' },
                },
            ]);
        } finally {
            if (OriginalWorker) {
                (globalThis as { Worker?: unknown }).Worker = OriginalWorker;
            } else {
                delete (globalThis as { Worker?: unknown }).Worker;
            }
        }
    });
});

describe('archiveLoader.mapArchiveEntries', () => {
    it('normalizes raw libarchive entries into the viewer shape', () => {
        const raw = [
            { path: 'a.txt', size: 5, type: 'FILE' },
            { path: 'dir/', size: 0, type: 'DIR' },
            { path: 'link', size: 0, type: 'SYMBOLIC_LINK' },
            // Entries without a path are dropped (libarchive emits these for
            // some malformed archives).
            { size: 99, type: 'FILE' },
        ];
        expect(mapArchiveEntries(raw)).toEqual([
            { path: 'a.txt', size: 5, isDirectory: false },
            { path: 'dir/', size: 0, isDirectory: true },
            { path: 'link', size: 0, isDirectory: false },
        ]);
    });

    it('returns an empty list when given a non-array', () => {
        expect(mapArchiveEntries(undefined as unknown as never)).toEqual([]);
    });
});

describe('archiveLoader.openArchive', () => {
    it('drives construct -> open -> listFiles in order and returns a handle', async () => {
        const worker = new MockWorker();
        const file = makeFakeFile(new Uint8Array([1, 2, 3, 4]), 'sample.zip');

        // Drive the loader by replying as each message arrives. We poll the
        // capture buffer so we don't have to assume how many microtasks the
        // loader spends on `file.arrayBuffer()` and the construct chain.
        const driver = (async (): Promise<void> => {
            const first = await waitForMessage(worker, 0);
            expect(first.type).toBe('CONSTRUCT');
            worker.reply(first.id, undefined);
            invokeReadyCallback(first);

            const second = await waitForMessage(worker, 1);
            expect(second.type).toBe('APPLY');
            expect(second.path).toEqual(['open']);
            worker.reply(second.id, undefined);
            invokeOpenCallback(second);

            const third = await waitForMessage(worker, 2);
            expect(third.path).toEqual(['listFiles']);
            worker.reply(third.id, [
                { path: 'README.md', size: 12, type: 'FILE' },
                { path: 'src/', size: 0, type: 'DIR' },
            ]);
        })();

        const handle = await openArchive(file, { worker });
        await driver;

        expect(handle.entries).toEqual([
            { path: 'README.md', size: 12, isDirectory: false },
            { path: 'src/', size: 0, isDirectory: true },
        ]);
    });

    it('terminates the worker if construct fails', async () => {
        const worker = new MockWorker();
        const file = makeFakeFile(new Uint8Array([0]), 'broken.zip');

        const driver = (async (): Promise<void> => {
            const first = await waitForMessage(worker, 0);
            // Synthesize a thrown reply for CONSTRUCT.
            for (const listener of listenersOf(worker)) {
                listener({
                    data: {
                        id: first.id,
                        type: 'HANDLER',
                        name: 'throw',
                        value: { isError: true, value: { message: 'boom', name: 'Error' } },
                    },
                } as MessageEvent);
            }
        })();

        await expect(openArchive(file, { worker })).rejects.toThrow('boom');
        await driver;
        expect(worker.terminated).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/** Drain the microtask queue. */
async function flushMicrotasks(): Promise<void> {
    // Two awaits handle deeper await chains in the loader (construct/open/list
    // each spawn at least one continuation).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

/**
 * Poll the worker's capture buffer until at least `index + 1` messages have
 * been recorded, then return the message at `index`. Each iteration drains
 * the microtask queue so the loader's await-chain can advance. Bounded so a
 * stuck test fails loudly instead of hanging.
 */
async function waitForMessage(worker: MockWorker, index: number): Promise<CapturedMessage> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (worker.sent.length > index) return worker.sent[index];
        // Mix microtask drain with a real timer tick so promises chained
        // through host APIs (e.g. Blob.arrayBuffer in jsdom) get a chance
        // to settle.
        await flushMicrotasks();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for worker message #${index}`);
}

/**
 * Reach into MockWorker's private listener list. We intentionally don't
 * expose this on the class to keep the public surface small; tests that
 * need to fire synthetic non-RAW replies use this helper.
 */
function listenersOf(worker: MockWorker): Array<(event: MessageEvent) => void> {
    return (worker as unknown as { messageListeners: Array<(event: MessageEvent) => void> }).messageListeners;
}

/**
 * Send the CONSTRUCT message and resolve it. Returns the captured CONSTRUCT
 * message so callers can branch off the post-CONSTRUCT state.
 */
async function dummyConstruct(
    proxy: ReturnType<typeof wrapArchiveWorker>,
    worker: MockWorker
): Promise<CapturedMessage> {
    const cp = proxy.construct();
    const msg = worker.sent[0];
    worker.reply(msg.id, undefined);
    invokeReadyCallback(msg);
    await cp;
    return msg;
}

/**
 * jsdom's `File` implementation in some Node/jest versions does not
 * implement `arrayBuffer()`. The loader only needs an object that exposes
 * `arrayBuffer()`; this helper builds one without depending on the host
 * `File` polyfill.
 */
function makeFakeFile(bytes: Uint8Array, name: string): File {
    // `as unknown as File` is intentional — we only need the surface the
    // loader actually touches. Casting through `unknown` keeps TS happy
    // without expanding the typecheck radius into the rest of the project.
    return {
        name,
        size: bytes.byteLength,
        type: 'application/octet-stream',
        async arrayBuffer(): Promise<ArrayBuffer> {
            // Copy into a fresh ArrayBuffer so the loader gets ownership.
            const buf = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buf).set(bytes);
            return buf;
        },
    } as unknown as File;
}
