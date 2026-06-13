// Worker-bridge for the libarchive.js bundle shipped under
// `vendor/libarchive-worker-bundle.js`.
//
// Why this file exists
// --------------------
// The bundle the project vendors is `libarchive.js`'s prebuilt worker. It
// uses Comlink internally and exposes a single class (`A`) with the methods
// `open(buffer, readyCallback)`, `listFiles()`, `extractSingleFile(path)`,
// `hasEncryptedData()`, `usePassword(passphrase)`, and `close()`. There is no
// "init/open/extract" plain-message API to call into directly — the only
// supported wire protocol is Comlink's. Adding a new npm dependency is
// disallowed (issue #55 guardrail), so this module re-implements the small
// subset of Comlink we need:
//
//   - CONSTRUCT to instantiate the exposed class on the worker side.
//   - APPLY to call methods on the resulting instance proxy.
//   - "proxy" handler serialization for the `readyCallback` argument the
//     class A constructor + `open()` require.
//
// Everything outside that subset is left out: GET, SET, RELEASE, throw
// handler, finalizers, nested proxies returned from APPLY (we only call
// methods that return RAW values: a Promise<void> for `open`, an array of
// entries for `listFiles`, an entry record for `extractSingleFile`).
//
// Public surface
// --------------
//   - `openArchive(file)` — opens an archive and returns a small handle with
//     `entries`, `extract(path)`, `close()`, plus `hasEncryptedData()`.
//   - `mapArchiveEntries(entries)` — normalizes the worker's entry records
//     into `ArchiveEntryInfo` (path, size, isDirectory). The viewer renders
//     against this normalized shape so the worker output format is not
//     leaked into the rest of the viewer.
//   - `createArchiveWorker(workerUrl)` and `wrapArchiveWorker(worker)` — the
//     internals are exported so unit tests can drop in a `MockWorker`.

type WireValue =
    | { type: 'RAW'; value: unknown }
    | { type: 'HANDLER'; name: 'proxy' | 'throw'; value: unknown };

type Message =
    | {
          id: string;
          type: 'CONSTRUCT';
          path: string[];
          argumentList: WireValue[];
      }
    | {
          id: string;
          type: 'APPLY';
          path: string[];
          argumentList: WireValue[];
      };

type WorkerLike = {
    postMessage(data: unknown, transfer?: Transferable[]): void;
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
    removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
    addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
    terminate?(): void;
};

interface MessagePortLike extends WorkerLike {
    start?(): void;
    close?(): void;
}

/** Raw entry shape returned by libarchive.js's `listFiles()`. */
export interface RawArchiveEntry {
    path?: string;
    size?: number;
    type?: string;
    lastModified?: number | null;
    fileData?: Uint8Array | ArrayBuffer;
    [key: string]: unknown;
}

/** Normalized entry that the viewer renders against. */
export interface ArchiveEntryInfo {
    path: string;
    size: number;
    isDirectory: boolean;
}

/** Public archive handle. */
export interface ArchiveHandle {
    entries: ArchiveEntryInfo[];
    extract(path: string): Promise<Uint8Array>;
    hasEncryptedData(): Promise<boolean>;
    close(): Promise<void>;
}

/** Default vendor URL for the worker bundle. Resolved via `chrome.runtime.getURL`. */
export function defaultWorkerUrl(): string {
    return chrome.runtime.getURL('vendor/libarchive-worker-bundle.js');
}

/**
 * Spawn the libarchive worker. Encapsulated so tests can stub it.
 */
export function createArchiveWorker(url: string = defaultWorkerUrl()): Worker {
    // The vendored libarchive bundle uses `import.meta.url` to locate its
    // sibling `libarchive.wasm`, so Chrome must execute it as a module
    // worker. A classic worker fails during startup before it can reply.
    return new Worker(url, { type: 'module' });
}

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------

function generateRequestId(): string {
    // Comlink's own implementation joins four random hex chunks; we mirror it
    // (the worker doesn't care about the format, but a unique-ish opaque
    // string is what it expects). `crypto.randomUUID()` is preferred when
    // available; fall back to Math.random for jsdom environments that lack
    // the global.
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
        return cryptoRef.randomUUID();
    }
    return Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)
    ).join('-');
}

/**
 * Serialize one outgoing argument. Functions become Comlink "proxy" handler
 * values: a fresh MessageChannel is created, the function is exposed on the
 * local port, and the remote port is transferred to the worker.
 *
 * Returns `[wireValue, transferables]` so the caller can collect every
 * transferable for the postMessage call.
 */
function serializeArgument(
    arg: unknown,
    transferables: Transferable[]
): WireValue {
    if (typeof arg === 'function') {
        const channel = new MessageChannel();
        exposeFunctionOnPort(arg as (...args: unknown[]) => unknown, channel.port1);
        transferables.push(channel.port2);
        return { type: 'HANDLER', name: 'proxy', value: channel.port2 };
    }
    return { type: 'RAW', value: arg };
}

/**
 * Mirror of Comlink's `i()` exposure for a single function. We listen on the
 * given port for APPLY/GET messages; APPLY invokes the function with the raw
 * arguments and replies with the RAW return value (no nested proxying — the
 * functions we expose here are simple done-callbacks).
 */
function exposeFunctionOnPort(
    fn: (...args: unknown[]) => unknown,
    port: MessagePortLike
): void {
    const handler = (event: MessageEvent): void => {
        const data = event.data as Message | undefined;
        if (!data || typeof data !== 'object' || !('id' in data)) return;
        const reply = (wire: WireValue): void => {
            port.postMessage({ ...wire, id: data.id });
        };
        if (data.type === 'APPLY') {
            try {
                const args = data.argumentList.map(deserializeWireValue);
                Promise.resolve(fn(...args))
                    .then((value) => reply({ type: 'RAW', value }))
                    .catch(() => reply({ type: 'RAW', value: undefined }));
            } catch {
                reply({ type: 'RAW', value: undefined });
            }
        } else {
            reply({ type: 'RAW', value: undefined });
        }
    };
    port.addEventListener('message', handler);
    port.start?.();
}

function deserializeWireValue(wire: WireValue): unknown {
    if (!wire || typeof wire !== 'object') return undefined;
    if (wire.type === 'RAW') return wire.value;
    // We do not call any function whose argument is a HANDLER reply, so this
    // path is unreachable in practice. Returning the raw value keeps the
    // function total.
    return wire.value;
}

/**
 * Translate a Comlink reply envelope into either the raw return value or a
 * thrown Error. The "throw" handler on the worker side ships the original
 * error as `{isError: true, value: {message, name, stack}}` (mirrored from
 * Comlink's serializer). For RAW replies we just return the inner value.
 */
function unwrapWireReply<T>(reply: WireValue | undefined): T {
    if (reply && reply.type === 'RAW') {
        return reply.value as T;
    }
    const inner = (reply && (reply as { value?: unknown }).value) as
        | { isError?: boolean; value?: { message?: string }; message?: string }
        | undefined;
    const message =
        (inner && inner.value && inner.value.message) ||
        (inner && inner.message) ||
        'libarchive worker call failed';
    throw new Error(String(message));
}

/**
 * Send one Comlink message and wait for the matching reply. This is the
 * heart of the request/response correlation: every outgoing message gets a
 * unique id, the listener filters incoming messages by id, and the matched
 * reply resolves the promise. The listener is removed on resolution to keep
 * the worker's `message` handler set bounded.
 */
const WORKER_REQUEST_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error(message)), WORKER_REQUEST_TIMEOUT_MS);
        promise
            .then((value) => {
                clearTimeout(timeoutId);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

function postRequest(
    port: WorkerLike,
    message: Message,
    transferables: Transferable[] = []
): Promise<WireValue> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
            port.removeEventListener('message', listener);
            port.removeEventListener('error', errorListener);
            port.removeEventListener('messageerror', messageErrorListener);
            clearTimeout(timeoutId);
        };
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            fn();
        };
        const listener = (event: MessageEvent): void => {
            const data = event.data as { id?: string } | undefined;
            if (!data || data.id !== message.id) return;
            settle(() => resolve(data as unknown as WireValue));
        };
        const errorListener = (event: ErrorEvent): void => {
            const messageText = event.message || 'libarchive worker failed';
            settle(() => reject(new Error(messageText)));
        };
        const messageErrorListener = (): void => {
            settle(() => reject(new Error('libarchive worker returned an unreadable message')));
        };
        const timeoutId = setTimeout(() => {
            settle(() => reject(new Error(`libarchive worker timed out while handling ${message.type}${message.path.length ? `:${message.path.join('.')}` : ''}`)));
        }, WORKER_REQUEST_TIMEOUT_MS);
        port.addEventListener('message', listener);
        port.addEventListener('error', errorListener);
        port.addEventListener('messageerror', messageErrorListener);
        try {
            port.postMessage(message, transferables);
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            settle(() => reject(new Error(messageText)));
        }
    });
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/** A thin promise-returning facade around the libarchive worker. */
export interface ArchiveWorkerProxy {
    /** CONSTRUCT class A on the worker side. Resolves once the wasm is ready. */
    construct(): Promise<void>;
    /** APPLY `proxy.open(file, doneCallback)` — opens the archive. */
    open(file: File | Blob): Promise<void>;
    /** APPLY `proxy.listFiles()` — returns the entry records. */
    listFiles(): Promise<RawArchiveEntry[]>;
    /** APPLY `proxy.extractSingleFile(path)`. */
    extractSingleFile(path: string): Promise<RawArchiveEntry | undefined>;
    /** APPLY `proxy.hasEncryptedData()`. */
    hasEncryptedData(): Promise<boolean>;
    /** APPLY `proxy.close()`. */
    close(): Promise<void>;
    /** Tear down the underlying worker. */
    terminate(): void;
}

/**
 * Wrap a `Worker` (or a worker-shaped mock) in a request/response promise
 * abstraction. The returned proxy mirrors the libarchive.js worker-side API
 * surface that we depend on. Callers `await proxy.construct()` once before
 * any other call.
 */
export function wrapArchiveWorker(worker: WorkerLike): ArchiveWorkerProxy {
    let constructed = false;
    let instancePort: WorkerLike = worker;

    async function construct(): Promise<void> {
        if (constructed) return;
        // libarchive.js's class A constructor takes a `readyCallback`.
        // The CONSTRUCT reply only means the Comlink proxy exists; the
        // underlying WASM-backed reader (`F` in the vendored bundle) is set
        // later. Calling open() before this callback fires produces
        // "Cannot read properties of null (reading 'open')" inside worker.
        const transferables: Transferable[] = [];
        let markReady!: () => void;
        const readyPromise = new Promise<void>((resolve) => {
            markReady = resolve;
        });
        const arg = serializeArgument(() => {
            markReady();
            return undefined;
        }, transferables);
        const reply = await postRequest(
            worker,
            {
                id: generateRequestId(),
                type: 'CONSTRUCT',
                path: [],
                argumentList: [arg],
            },
            transferables
        );
        if (reply.type === 'HANDLER' && reply.name === 'proxy') {
            instancePort = reply.value as WorkerLike;
            (instancePort as MessagePortLike).start?.();
        } else {
            unwrapWireReply(reply);
        }
        await withTimeout(
            readyPromise,
            'libarchive worker timed out while initializing'
        );
        constructed = true;
    }

    async function applyMethod<T>(
        method: string,
        args: unknown[]
    ): Promise<T> {
        const transferables: Transferable[] = [];
        const argList = args.map((a) => serializeArgument(a, transferables));
        const reply = await postRequest(
            instancePort,
            {
                id: generateRequestId(),
                type: 'APPLY',
                path: [method],
                argumentList: argList,
            },
            transferables
        );
        return unwrapWireReply<T>(reply);
    }

    return {
        construct,
        async open(file) {
            // The vendored worker expects a Blob/File and calls
            // `file.arrayBuffer()` internally. Its open() method does not
            // return the loading Promise; completion is reported only via
            // the second callback argument.
            let markOpened!: () => void;
            const openedPromise = new Promise<void>((resolve) => {
                markOpened = resolve;
            });
            await applyMethod<void>('open', [file, () => {
                markOpened();
                return undefined;
            }]);
            await withTimeout(
                openedPromise,
                'libarchive worker timed out while opening the archive'
            );
        },
        listFiles() {
            return applyMethod<RawArchiveEntry[]>('listFiles', []);
        },
        extractSingleFile(path) {
            return applyMethod<RawArchiveEntry | undefined>('extractSingleFile', [path]);
        },
        hasEncryptedData() {
            return applyMethod<boolean>('hasEncryptedData', []);
        },
        close() {
            return applyMethod<void>('close', []);
        },
        terminate() {
            worker.terminate?.();
        },
    };
}

// ---------------------------------------------------------------------------
// Entry normalization
// ---------------------------------------------------------------------------

/**
 * Map the worker's entry records into the normalized shape the viewer
 * renders against. libarchive.js exposes file types via a string enum
 * (`FILE`, `DIR`, `SYMBOLIC_LINK`, …); we treat anything that is not `DIR`
 * as a file for preview purposes. Symlinks/devices fall through to "file"
 * with their reported size, which matches how the VSCode reference viewer
 * lists them.
 */
export function mapArchiveEntries(entries: RawArchiveEntry[]): ArchiveEntryInfo[] {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter((entry) => typeof entry?.path === 'string' && entry.path.length > 0)
        .map((entry) => ({
            path: String(entry.path),
            size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0,
            isDirectory: entry.type === 'DIR',
        }));
}

/**
 * Friendly message surfaced when libarchive cannot open a DMG image. The
 * libarchive build we ship covers a subset of DMG payloads (UDIF/UDZO and a
 * handful of others); HFS+/APFS images in particular are partially supported.
 *
 * Re-exported from `utils/fileUtils/archive.ts` so the viewer doesn't need to
 * import that module just for the string constant.
 */
export const DMG_PARTIAL_SUPPORT_MESSAGE =
    "DMG (HFS+/APFS) is partially supported; some images can't be browsed.";

/**
 * Returns true when the supplied filename has a `.dmg` extension. Used by
 * `openArchive` to swap the raw libarchive error for a friendlier notice.
 */
function hasDmgExtension(fileName: string | undefined): boolean {
    if (typeof fileName !== 'string' || fileName.length === 0) return false;
    return fileName.toLowerCase().endsWith('.dmg');
}

/**
 * Wrap an error thrown while opening a DMG so the viewer can surface a
 * partially-supported notice instead of leaking the raw libarchive message.
 */
function wrapDmgOpenError(error: unknown): Error {
    const original = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`${DMG_PARTIAL_SUPPORT_MESSAGE} (${original})`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    return wrapped;
}

/**
 * Open an archive end-to-end: spawn worker, construct, open, list. The
 * returned handle owns the worker and exposes a `close()` that terminates
 * it so blob memory and the wasm instance are released when the viewer is
 * disposed.
 *
 * For `.dmg` files, an open/listFiles failure is rewritten to a friendlier
 * "DMG (HFS+/APFS) is partially supported" message — see issue #58.
 */
export async function openArchive(
    file: File | Blob,
    options: { worker?: WorkerLike } = {}
): Promise<ArchiveHandle & { terminate(): void }> {
    const worker = options.worker ?? createArchiveWorker();
    const proxy = wrapArchiveWorker(worker);
    const fileName = (file as File).name;
    const isDmg = hasDmgExtension(fileName);
    try {
        await proxy.construct();
        try {
            await proxy.open(file);
        } catch (openError) {
            if (isDmg) {
                throw wrapDmgOpenError(openError);
            }
            throw openError;
        }
        let rawEntries: RawArchiveEntry[];
        try {
            rawEntries = await proxy.listFiles();
        } catch (listError) {
            if (isDmg) {
                throw wrapDmgOpenError(listError);
            }
            throw listError;
        }
        const entries = mapArchiveEntries(rawEntries);
        return {
            entries,
            async extract(path: string): Promise<Uint8Array> {
                const entry = await proxy.extractSingleFile(path);
                if (!entry || !entry.fileData) {
                    throw new Error(`Entry not found in archive: ${path}`);
                }
                if (entry.fileData instanceof Uint8Array) {
                    return entry.fileData;
                }
                return new Uint8Array(entry.fileData as ArrayBuffer);
            },
            async hasEncryptedData(): Promise<boolean> {
                try {
                    return Boolean(await proxy.hasEncryptedData());
                } catch {
                    return false;
                }
            },
            async close(): Promise<void> {
                try {
                    await proxy.close();
                } catch {
                    // best-effort
                }
                proxy.terminate();
            },
            terminate(): void {
                proxy.terminate();
            },
        };
    } catch (error) {
        proxy.terminate();
        throw error;
    }
}
