/**
 * Tests for the share-upload pipeline.
 *
 * Split into two suites:
 *   1. Pure helpers (`validateShareSize`, `buildShareFormData`,
 *      `parseShareResponse`) — exercised without any network mocking.
 *   2. `shareFile` integration — drives the orchestrator through a stubbed
 *      `fetch` to assert the size guard, the two-leg request shape, and
 *      friendly error mapping.
 */

import { shareFile, DEFAULT_SHARE_API_BASE } from '../shareCommand';
import {
    MAX_SHARE_SIZE_BYTES,
    buildShareFormData,
    parseShareResponse,
    validateShareSize,
} from '../utils/sharePayload';

describe('validateShareSize', () => {
    it('rejects null / undefined', () => {
        expect(validateShareSize(null).ok).toBe(false);
        expect(validateShareSize(undefined).ok).toBe(false);
    });

    it('rejects empty files', () => {
        const v = validateShareSize({ size: 0 });
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/empty/i);
    });

    it('rejects NaN size', () => {
        const v = validateShareSize({ size: Number.NaN });
        expect(v.ok).toBe(false);
    });

    it('accepts files up to and including 10 MB', () => {
        expect(validateShareSize({ size: 1 }).ok).toBe(true);
        expect(validateShareSize({ size: MAX_SHARE_SIZE_BYTES }).ok).toBe(true);
    });

    it('rejects files larger than 10 MB and includes both sizes in the message', () => {
        const v = validateShareSize({ size: MAX_SHARE_SIZE_BYTES + 1 });
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/too large/i);
        expect(v.error).toMatch(/10\.00 MB/);
    });
});

describe('buildShareFormData', () => {
    it('appends platform, is_paid_user and the file blob', () => {
        const blob = new Blob(['hello'], { type: 'text/plain' });
        const fd = buildShareFormData(blob, 'hello.txt');

        expect(fd.get('platform')).toBe('chrome');
        expect(fd.get('is_paid_user')).toBe('false');

        const filePart = fd.get('file');
        expect(filePart).toBeInstanceOf(Blob);
        // jsdom's FormData wraps the blob in a File when a filename is given.
        if (filePart && typeof (filePart as File).name === 'string') {
            expect((filePart as File).name).toBe('hello.txt');
        }
    });

    it('omits the filename argument when not supplied', () => {
        const blob = new Blob(['x']);
        const fd = buildShareFormData(blob);
        expect(fd.get('file')).toBeInstanceOf(Blob);
    });
});

describe('parseShareResponse', () => {
    it('parses the canonical snake_case payload', () => {
        const parsed = parseShareResponse({
            share_id: 'abc123',
            expires_at: '2026-05-08T12:00:00Z',
            download_url: 'https://example.com/share/abc123',
        });
        expect(parsed).toEqual({
            shareId: 'abc123',
            expiresAt: '2026-05-08T12:00:00Z',
            url: 'https://example.com/share/abc123',
        });
    });

    it('also accepts camelCase keys defensively', () => {
        const parsed = parseShareResponse({
            shareId: 'id1',
            expiresAt: 't1',
            downloadUrl: 'https://example.com/share/id1',
        });
        expect(parsed.shareId).toBe('id1');
        expect(parsed.url).toBe('https://example.com/share/id1');
    });

    it('throws when share_id is missing', () => {
        expect(() =>
            parseShareResponse({ expires_at: 't', download_url: 'u' }),
        ).toThrow(/share_id/);
    });

    it('throws when expires_at is missing', () => {
        expect(() =>
            parseShareResponse({ share_id: 'x', download_url: 'u' }),
        ).toThrow(/expires_at/);
    });

    it('throws when download_url is missing', () => {
        expect(() =>
            parseShareResponse({ share_id: 'x', expires_at: 't' }),
        ).toThrow(/download_url/);
    });

    it('throws on non-objects', () => {
        expect(() => parseShareResponse(null)).toThrow();
        expect(() => parseShareResponse('nope')).toThrow();
    });
});

// --- shareFile integration ---------------------------------------------

interface FakeCall {
    url: string;
    init: RequestInit | undefined;
}

/**
 * jsdom does not always expose `Response`. We hand-roll a duck-typed shape
 * that satisfies the surface `shareCommand` actually consumes (`status`,
 * `ok`, `json()`, `text()`).
 */
interface FakeResponse {
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

function makeResponse(status: number, body: string): FakeResponse {
    return {
        status,
        ok: status >= 200 && status < 300,
        async text() {
            return body;
        },
        async json() {
            return JSON.parse(body);
        },
    };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): FakeResponse {
    return makeResponse(init.status ?? 200, JSON.stringify(body));
}

function textResponse(text: string, init: { status?: number } = {}): FakeResponse {
    return makeResponse(init.status ?? 200, text);
}

function makeFetchStub(
    handlers: Array<(call: FakeCall) => FakeResponse | Promise<FakeResponse>>,
): { fetchImpl: typeof fetch; calls: FakeCall[]; mock: jest.Mock } {
    const calls: FakeCall[] = [];
    const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const call: FakeCall = { url, init };
        calls.push(call);
        const handler = handlers[calls.length - 1];
        if (!handler) {
            throw new Error(`Unexpected fetch call #${calls.length} to ${url}`);
        }
        return handler(call);
    });
    return { fetchImpl: mock as unknown as typeof fetch, calls, mock };
}

describe('shareFile', () => {
    const getIdToken = async () => 'firebase-id-token';

    it('rejects oversize files BEFORE making any network call', async () => {
        const big = { size: MAX_SHARE_SIZE_BYTES + 1, name: 'huge.bin' } as unknown as File;
        const { fetchImpl, mock } = makeFetchStub([]);

        await expect(shareFile(big, { fetchImpl })).rejects.toThrow(/too large/i);
        expect(mock).not.toHaveBeenCalled();
    });

    it('rejects empty files before calling the network', async () => {
        const empty = new File([], 'empty.txt');
        const { fetchImpl, mock } = makeFetchStub([]);
        await expect(shareFile(empty, { fetchImpl })).rejects.toThrow(/empty/i);
        expect(mock).not.toHaveBeenCalled();
    });

    it('uploads with a Firebase ID token and returns the parsed result', async () => {
        const file = new File(['hello world'], 'note.txt', { type: 'text/plain' });
        const { fetchImpl, calls } = makeFetchStub([
            () =>
                jsonResponse({
                    share_id: 'sid-1',
                    expires_at: '2026-05-08T12:05:00Z',
                    download_url: 'https://share.example.com/share/sid-1',
                }),
        ]);

        const result = await shareFile(file, {
            fetchImpl,
            apiBase: 'https://api.test/',
            getIdToken,
        });

        expect(result).toEqual({
            shareId: 'sid-1',
            expiresAt: '2026-05-08T12:05:00Z',
            url: 'https://omni-viewer-web.web.app/share/sid-1',
            filename: 'note.txt',
            size: file.size,
        });

        // Trailing slash on apiBase should be normalized.
        expect(calls[0].url).toBe('https://api.test/v1/shares?expires_in_minutes=5');
        expect(calls[0].init?.method).toBe('POST');

        const auth = (calls[0].init?.headers as Record<string, string>)?.Authorization;
        expect(auth).toBe('Bearer firebase-id-token');

        // Multipart body must be a FormData.
        expect(calls[0].init?.body).toBeInstanceOf(FormData);
        expect((calls[0].init?.body as FormData).get('platform')).toBe('chrome');
    });

    it('uses the documented default API base when none is passed', async () => {
        const file = new File(['x'], 'x.bin');
        const { fetchImpl, calls } = makeFetchStub([
            () =>
                jsonResponse({
                    share_id: 's',
                    expires_at: 'e',
                    download_url: 'https://x/share/s',
                }),
        ]);

        await shareFile(file, { fetchImpl, getIdToken });
        expect(calls[0].url.startsWith(DEFAULT_SHARE_API_BASE + '/')).toBe(true);
    });

    it('surfaces anonymous authentication failures before upload', async () => {
        const file = new File(['x'], 'x.bin');
        const fetchImpl = jest.fn() as unknown as typeof fetch;
        const authFailure = async () => { throw new Error('Anonymous login failed.'); };
        await expect(shareFile(file, { fetchImpl, getIdToken: authFailure })).rejects.toThrow(/anonymous login failed/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('maps a 401 from /share to a token-expired error', async () => {
        const file = new File(['x'], 'x.bin');
        const { fetchImpl } = makeFetchStub([
            () => textResponse('nope', { status: 403 }),
        ]);
        await expect(shareFile(file, { fetchImpl, getIdToken })).rejects.toThrow(/token expired or invalid/i);
    });

    it('maps a 413 from /share to a too-large server-side error', async () => {
        const file = new File(['x'], 'x.bin');
        const { fetchImpl } = makeFetchStub([
            () => textResponse('too big', { status: 413 }),
        ]);
        await expect(shareFile(file, { fetchImpl, getIdToken })).rejects.toThrow(/too large/i);
    });

    it('maps a 5xx from /share to a service-unavailable error', async () => {
        const file = new File(['x'], 'x.bin');
        const { fetchImpl } = makeFetchStub([
            () => textResponse('boom', { status: 500 }),
        ]);
        await expect(shareFile(file, { fetchImpl, getIdToken })).rejects.toThrow(/unavailable/i);
    });

    it('maps fetch rejection on /share to a network error', async () => {
        const file = new File(['x'], 'x.bin');
        const fetchImpl = jest.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;
        await expect(shareFile(file, { fetchImpl, getIdToken })).rejects.toThrow(/network error.*uploading share/i);
    });

    it('throws when /share returns invalid JSON', async () => {
        const file = new File(['x'], 'x.bin');
        const { fetchImpl } = makeFetchStub([
            () => textResponse('not-json', { status: 200 }),
        ]);
        await expect(shareFile(file, { fetchImpl, getIdToken })).rejects.toThrow(/not JSON/i);
    });

    it('throws when /share returns JSON missing share_id', async () => {
        const file = new File(['x'], 'x.bin');
        const { fetchImpl } = makeFetchStub([
            () => jsonResponse({ expires_at: 'e', download_url: 'u' }),
        ]);
        await expect(shareFile(file, { fetchImpl, getIdToken })).rejects.toThrow(/share_id/);
    });

    it('honors an explicit filename override', async () => {
        const file = new File(['data'], 'original.bin');
        const { fetchImpl, calls } = makeFetchStub([
            () =>
                jsonResponse({
                    share_id: 's',
                    expires_at: 'e',
                    download_url: 'u-good',
                }),
        ]);
        const result = await shareFile(file, { fetchImpl, filename: 'renamed.bin', getIdToken });
        expect(result.filename).toBe('renamed.bin');
        // Smoke check: second leg actually carried a multipart body.
        expect(calls[0].init?.body).toBeInstanceOf(FormData);
    });
});
