// jest-environment-jsdom@29 does not expose TextEncoder/TextDecoder as
// globals. Polyfill from node:util before importing the module under test
// so its lazy decoders pick them up.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
}
if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof NodeTextDecoder }).TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

import {
    detectArchiveFormatByExtension,
    detectArchiveFormatByMagic,
    isArchiveFileName,
    DMG_PARTIAL_SUPPORT_MESSAGE
} from '../utils/fileUtils/archive';
import { FileUtils } from '../utils/fileUtils';

/**
 * Issue #58 — verifies that the new archive extensions (`.dmg`, `.tbz2`,
 * `.tar.bz2`, `.txz`, `.tar.xz`, `.bz2`, `.xz`) are
 *
 *   1. classified by `detectArchiveFormatByExtension`,
 *   2. routed to the archive viewer by `FileUtils.detectViewerType`,
 *   3. recognised by `detectArchiveFormatByMagic` for the formats with
 *      stable magic bytes (BZ2, XZ).
 *
 * The DMG-specific friendly message constant is also asserted so changes to
 * the user-facing copy surface as failing tests.
 */

function makeFile(bytes: Uint8Array | number[], name: string): File {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new File([payload], name);
}

describe('detectArchiveFormatByExtension', () => {
    it.each([
        ['archive.dmg', 'dmg'],
        ['archive.tbz2', 'tarBz2'],
        ['archive.tar.bz2', 'tarBz2'],
        ['archive.txz', 'tarXz'],
        ['archive.tar.xz', 'tarXz'],
        ['payload.bz2', 'bz2'],
        ['payload.xz', 'xz'],
        ['archive.tar.gz', 'tarGz'],
        ['archive.tgz', 'tarGz'],
        ['archive.zip', 'zip'],
        ['archive.7z', 'sevenZip'],
        ['archive.rar', 'rar'],
        ['archive.tar', 'tar'],
        ['archive.gz', 'gz'],
        ['archive.jar', 'jar'],
        ['archive.apk', 'apk']
    ])('classifies %s as %s', (fileName, expected) => {
        expect(detectArchiveFormatByExtension(fileName)).toBe(expected);
    });

    it('prefers compound extensions over the trailing single extension', () => {
        // `.tar.gz` must beat `.gz`, `.tar.bz2` must beat `.bz2`, etc.
        expect(detectArchiveFormatByExtension('build.tar.gz')).toBe('tarGz');
        expect(detectArchiveFormatByExtension('build.tar.bz2')).toBe('tarBz2');
        expect(detectArchiveFormatByExtension('build.tar.xz')).toBe('tarXz');
    });

    it('is case-insensitive', () => {
        expect(detectArchiveFormatByExtension('FOO.DMG')).toBe('dmg');
        expect(detectArchiveFormatByExtension('Bar.Tar.Bz2')).toBe('tarBz2');
        expect(detectArchiveFormatByExtension('Baz.XZ')).toBe('xz');
    });

    it('returns null for non-archive extensions', () => {
        expect(detectArchiveFormatByExtension('photo.png')).toBeNull();
        expect(detectArchiveFormatByExtension('notes.txt')).toBeNull();
        expect(detectArchiveFormatByExtension('no-extension')).toBeNull();
    });
});

describe('isArchiveFileName', () => {
    it('reports true for the new archive types', () => {
        expect(isArchiveFileName('image.dmg')).toBe(true);
        expect(isArchiveFileName('payload.bz2')).toBe(true);
        expect(isArchiveFileName('payload.xz')).toBe(true);
        expect(isArchiveFileName('archive.tbz2')).toBe(true);
        expect(isArchiveFileName('archive.txz')).toBe(true);
        expect(isArchiveFileName('archive.tar.bz2')).toBe(true);
        expect(isArchiveFileName('archive.tar.xz')).toBe(true);
    });

    it('reports false for unknown extensions', () => {
        expect(isArchiveFileName('photo.png')).toBe(false);
        expect(isArchiveFileName('notes.txt')).toBe(false);
    });
});

describe('detectArchiveFormatByMagic', () => {
    it('sniffs BZ2 from the "BZh" prefix (42 5A 68)', () => {
        // BZh + version byte ('1' .. '9'). Real bzip2 streams use '9' for the
        // 900K block size, but only the first three bytes are diagnostic.
        const bytes = new Uint8Array([0x42, 0x5A, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26]);
        expect(detectArchiveFormatByMagic(bytes)).toBe('bz2');
    });

    it('sniffs XZ from FD 37 7A 58 5A 00', () => {
        const bytes = new Uint8Array([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00, 0x00, 0x04]);
        expect(detectArchiveFormatByMagic(bytes)).toBe('xz');
    });

    it('sniffs GZIP from 1F 8B', () => {
        expect(detectArchiveFormatByMagic(new Uint8Array([0x1F, 0x8B, 0x08, 0x00]))).toBe('gz');
    });

    it('sniffs 7-Zip from 37 7A BC AF 27 1C', () => {
        expect(
            detectArchiveFormatByMagic(new Uint8Array([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]))
        ).toBe('sevenZip');
    });

    it('sniffs ZIP from PK\\x03\\x04', () => {
        expect(detectArchiveFormatByMagic(new Uint8Array([0x50, 0x4B, 0x03, 0x04]))).toBe('zip');
    });

    it('returns null for unknown leading bytes', () => {
        expect(detectArchiveFormatByMagic(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    });

    it('returns null for empty/short buffers', () => {
        expect(detectArchiveFormatByMagic(new Uint8Array([]))).toBeNull();
        expect(detectArchiveFormatByMagic(new Uint8Array([0x42]))).toBeNull();
    });
});

describe('FileUtils.detectViewerType routes new archive extensions to the archive viewer', () => {
    it('routes .dmg by extension fallback', async () => {
        // DMG payloads vary; for the routing test we use a small generic
        // payload that should not trip any other signature.
        const file = makeFile([0x00, 0x01, 0x02, 0x03], 'image.dmg');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('archive extension fallback');
    });

    it('routes .bz2 by the BZh signature', async () => {
        const file = makeFile([0x42, 0x5A, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26], 'payload.bz2');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('BZIP2');
    });

    it('routes .xz by the FD 37 7A 58 5A 00 signature', async () => {
        const file = makeFile([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00, 0x00, 0x04], 'payload.xz');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
        expect(result.reason).toContain('XZ');
    });

    it('routes .tbz2 by extension when the bytes are nondescript', async () => {
        const file = makeFile([0x00, 0x00, 0x00, 0x00], 'archive.tbz2');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('archive extension fallback');
    });

    it('routes .tar.bz2 by the BZh signature on the wrapping bzip2 stream', async () => {
        const file = makeFile([0x42, 0x5A, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26], 'archive.tar.bz2');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });

    it('routes .txz by extension when the bytes are nondescript', async () => {
        const file = makeFile([0x00, 0x00, 0x00, 0x00], 'archive.txz');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(false);
        expect(result.reason).toContain('archive extension fallback');
    });

    it('routes .tar.xz by the XZ signature on the wrapping xz stream', async () => {
        const file = makeFile([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00, 0x00, 0x04], 'archive.tar.xz');
        const result = await FileUtils.detectViewerType(file);
        expect(result.viewType).toBe('omni-viewer.archiveViewer');
        expect(result.matchedBySignature).toBe(true);
    });
});

describe('DMG friendly notice', () => {
    it('exposes a stable, descriptive partial-support message', () => {
        expect(DMG_PARTIAL_SUPPORT_MESSAGE).toMatch(/DMG/);
        expect(DMG_PARTIAL_SUPPORT_MESSAGE).toMatch(/HFS\+\/APFS/);
        expect(DMG_PARTIAL_SUPPORT_MESSAGE).toMatch(/partially supported/);
    });

    it('archiveLoader re-exports the same DMG message constant', async () => {
        // Lazy import so we don't pull the loader (and its MessageChannel
        // polyfill needs) into the bulk of the suite.
        const loader = await import('../templates/archive/js/archiveLoader');
        expect(loader.DMG_PARTIAL_SUPPORT_MESSAGE).toBe(DMG_PARTIAL_SUPPORT_MESSAGE);
    });
});

describe('archiveLoader.openArchive DMG error wrapping', () => {
    // jsdom does not ship MessageChannel; provide a tiny noop polyfill so the
    // loader can serialize its callable arguments. The mock worker below
    // never fires the proxied callback, so we don't need wired ports.
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

    interface CapturedMessage {
        id: string;
        type: 'CONSTRUCT' | 'APPLY';
        path: string[];
        argumentList: Array<{ type: string; value?: unknown; name?: string }>;
    }

    class MockWorker {
        public readonly sent: CapturedMessage[] = [];
        public messageListeners: Array<(event: MessageEvent) => void> = [];
        public errorListeners: Array<(event: ErrorEvent) => void> = [];
        public messageErrorListeners: Array<(event: MessageEvent) => void> = [];
        public terminated = false;

        public postMessage(data: unknown): void {
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
        public reply(id: string, value: unknown): void {
            const event = { data: { id, type: 'RAW', value } } as MessageEvent;
            const snapshot = [...this.messageListeners];
            for (const listener of snapshot) listener(event);
        }
        public throwReply(id: string, message: string): void {
            const event = {
                data: {
                    id,
                    type: 'HANDLER',
                    name: 'throw',
                    value: { isError: true, value: { message, name: 'Error' } }
                }
            } as MessageEvent;
            const snapshot = [...this.messageListeners];
            for (const listener of snapshot) listener(event);
        }
    }

    function invokeReadyCallback(message: CapturedMessage): void {
        const port = message.argumentList[0].value as FakeMessagePort | undefined;
        port?.postMessage({ id: `ready-${message.id}`, type: 'APPLY', path: [], argumentList: [] });
    }

    function makeFakeFile(name: string, bytes: number[] = [0x00]): File {
        const payload = new Uint8Array(bytes);
        return {
            name,
            size: payload.byteLength,
            type: 'application/x-apple-diskimage',
            async arrayBuffer(): Promise<ArrayBuffer> {
                const buf = new ArrayBuffer(payload.byteLength);
                new Uint8Array(buf).set(payload);
                return buf;
            }
        } as unknown as File;
    }

    async function flush(): Promise<void> {
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    it('rewrites a DMG open() failure to the partial-support message', async () => {
        const { openArchive } = await import('../templates/archive/js/archiveLoader');
        const worker = new MockWorker();
        const file = makeFakeFile('image.dmg');

        const driver = (async (): Promise<void> => {
            // Wait for CONSTRUCT, reply success.
            for (let i = 0; i < 200 && worker.sent.length < 1; i++) await flush();
            worker.reply(worker.sent[0].id, undefined);
            invokeReadyCallback(worker.sent[0]);
            // Wait for open(), reply with a thrown libarchive error.
            for (let i = 0; i < 200 && worker.sent.length < 2; i++) await flush();
            worker.throwReply(worker.sent[1].id, 'Unrecognized archive format');
        })();

        await expect(openArchive(file, { worker })).rejects.toThrow(/partially supported/);
        await driver;
        expect(worker.terminated).toBe(true);
    });

    it('does not rewrite errors for non-DMG files', async () => {
        const { openArchive } = await import('../templates/archive/js/archiveLoader');
        const worker = new MockWorker();
        const file = makeFakeFile('archive.zip');

        const driver = (async (): Promise<void> => {
            for (let i = 0; i < 200 && worker.sent.length < 1; i++) await flush();
            worker.reply(worker.sent[0].id, undefined);
            invokeReadyCallback(worker.sent[0]);
            for (let i = 0; i < 200 && worker.sent.length < 2; i++) await flush();
            worker.throwReply(worker.sent[1].id, 'Unrecognized archive format');
        })();

        await expect(openArchive(file, { worker })).rejects.toThrow('Unrecognized archive format');
        await driver;
        expect(worker.terminated).toBe(true);
    });
});
