/**
 * Browser-flavored share-upload orchestrator.
 *
 * Equivalent to `shareCommand.ts` in the VSCode build, but uses `fetch`
 * and `FormData` instead of Node's `https`. The flow:
 *
 *   1. Validate the file against the 10 MB ceiling (no network call).
 *   2. Seal the file and its name/MIME type in an OVS2 envelope under a
 *      fresh key (see `utils/shareCrypto.ts`).
 *   3. Sign in anonymously with Firebase and obtain an ID token.
 *   4. POST multipart `/v2/shares` with `Authorization: Bearer <id-token>`.
 *   5. Build the link as `<web>/share/<id>#k=<key>`; the key never leaves
 *      the client except in that fragment.
 *
 * UI wiring lives in the Chrome viewer shell. This module remains pure-ish
 * (returns a `Promise<ShareResult>`, throws `Error` on failure) so callers
 * choose how to surface progress and errors.
 */

import {
    MAX_SHARE_SIZE_BYTES,
    ParsedShareResponse,
    buildShareFormData,
    parseShareInput,
    parseShareResponse,
    validateShareSize,
} from './utils/sharePayload';
import { getFirebaseAnonymousIdToken } from './firebaseAnonymousAuth';
import { decryptShareFile, encryptShareFile, readShareLinkKey } from './utils/shareCrypto';

/** Default share API base. Inject `apiBase` to override (e.g. tests, staging). */
export const DEFAULT_SHARE_API_BASE = 'https://omni-viewer-share-624036133562.us-west1.run.app';
export const DEFAULT_SHARE_WEB_BASE = 'https://omni-viewer-web.web.app';

/** Public options accepted by {@link shareFile}. */
export interface ShareFileOptions {
    /** Override the API base URL. Trailing slashes are tolerated. */
    apiBase?: string;
    /** Override the filename sealed in the envelope (defaults to `file.name`). */
    filename?: string;
    /**
     * Optional `fetch` override. Mostly useful for tests that want to stub
     * the network without monkey-patching `globalThis.fetch`.
     */
    fetchImpl?: typeof fetch;
    /** Optional abort signal forwarded to every underlying `fetch` call. */
    signal?: AbortSignal;
    /** Override anonymous authentication in tests or alternate clients. */
    getIdToken?: () => Promise<string>;
}

/** Successful share upload result. */
export interface ShareResult extends ParsedShareResponse {
    filename: string;
    size: number;
}

/**
 * Validate, upload, and mint a share for a single file.
 *
 * Throws a friendly `Error` on any failure path:
 *   - size guard (>10 MB or empty)
 *   - Firebase anonymous authentication failure
 *   - share endpoint 401 / 5xx / non-JSON / malformed
 *   - network errors (`fetch` rejection)
 */
export async function shareFile(file: File | Blob, opts: ShareFileOptions = {}): Promise<ShareResult> {
    const filename = opts.filename ?? (isNamedFile(file) ? file.name : 'shared-file');
    const sizeCheck = validateShareSize({ size: file.size, name: filename });
    if (!sizeCheck.ok) {
        throw new Error(sizeCheck.error ?? 'File failed share size validation.');
    }

    const apiBase = normalizeBase(opts.apiBase ?? DEFAULT_SHARE_API_BASE);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

    const { envelope, key } = await encryptShareFile(file, {
        filename,
        content_type: file.type || 'application/octet-stream',
        // Left empty so the receiving viewer detects the type itself, as it
        // did for v1 shares from Chrome.
        file_type: '',
        file_meta: {},
    });
    // The server limit applies to the envelope, which is slightly larger.
    if (envelope.size > MAX_SHARE_SIZE_BYTES) {
        throw new Error(`File is too large to share once encrypted (max ${MAX_SHARE_SIZE_BYTES} bytes).`);
    }

    const token = await (opts.getIdToken ?? (() => getFirebaseAnonymousIdToken({ fetchImpl })))();
    const minted = await postShare(apiBase, token, envelope, fetchImpl, opts.signal);

    return {
        ...minted,
        url: `${DEFAULT_SHARE_WEB_BASE}/share/${encodeURIComponent(minted.shareId)}#k=${key}`,
        filename,
        size: file.size,
    };
}

// --- internals ----------------------------------------------------------

async function postShare(
    apiBase: string,
    token: string,
    envelope: Blob,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
): Promise<ParsedShareResponse> {
    const fd = buildShareFormData(envelope);

    let res: Response;
    try {
        res = await fetchImpl(`${apiBase}/v2/shares?expires_in_minutes=5`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
            signal,
        });
    } catch (err) {
        throw new Error(`Network error while uploading share: ${describeError(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
        throw new Error('Share upload was rejected (token expired or invalid).');
    }
    if (res.status === 413) {
        throw new Error(`File is too large to share (server limit, max ${MAX_SHARE_SIZE_BYTES} bytes).`);
    }
    if (!res.ok) {
        const detail = await safeReadError(res);
        throw new Error(
            res.status >= 500
                ? `Share service is unavailable (HTTP ${res.status}). ${detail}`.trim()
                : `Share upload failed (HTTP ${res.status}). ${detail}`.trim(),
        );
    }

    let parsed: unknown;
    try {
        parsed = await res.json();
    } catch {
        throw new Error('Invalid response from share endpoint (not JSON).');
    }
    return parseShareResponse(parsed);
}

async function safeReadError(res: Response): Promise<string> {
    try {
        const text = (await res.text()).trim();
        if (!text) return '';
        try {
            const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
            const fromError = json?.error?.message;
            if (typeof fromError === 'string' && fromError.trim()) return fromError.trim();
            const fromTop = json?.message;
            if (typeof fromTop === 'string' && fromTop.trim()) return fromTop.trim();
            return text;
        } catch {
            return text;
        }
    } catch {
        return '';
    }
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message || err.name;
    return String(err);
}

function normalizeBase(base: string): string {
    return base.replace(/\/+$/, '');
}

function isNamedFile(file: Blob | File): file is File {
    return typeof (file as File).name === 'string' && (file as File).name.length > 0;
}

// --- openSharedLink -----------------------------------------------------

/** Public options accepted by {@link openSharedLink}. */
export interface OpenSharedLinkOptions {
    /** Override the API base URL. Trailing slashes are tolerated. */
    apiBase?: string;
    /**
     * Optional `fetch` override. Mostly useful for tests that want to stub
     * the network without monkey-patching `globalThis.fetch`.
     */
    fetchImpl?: typeof fetch;
    /** Optional abort signal forwarded to every underlying `fetch` call. */
    signal?: AbortSignal;
    /** Override the signed-URL download transport (Chrome uses its service worker). */
    downloadImpl?: (url: string, signal?: AbortSignal) => Promise<Blob>;
}

/** Server-issued ticket describing a shared file we are allowed to download. */
interface DownloadTicket {
    download_url: string;
    filename: string;
    mime: string;
}

type ShareApiVersion = 'v1' | 'v2';

/**
 * Resolve a share URL or bare share ID into a downloadable `File`.
 *
 * Steps:
 *   1. Parse the input (URL or raw ID) into `{ shareId, fragment }`.
 *   2. Pick the API version from the fragment: a `#k=<key>` means v2, no key
 *      means v1. The server keeps the two apart (each 404s on the other's
 *      shares) and a ticket spends an access, so we never probe one version
 *      and fall back to the other. A malformed key fails before any request.
 *   3. `GET <apiBase>/<version>/shares/<id>/download` for the ticket.
 *   4. Download the bytes from `download_url`; for v2, decrypt them and take
 *      the name and MIME type from the authenticated metadata.
 *   5. Wrap them in a `File` so the caller can hand it directly to the
 *      router. (We deliberately do not mount the file ourselves.)
 *
 * Friendly error mapping:
 *   - 410 on `/share/<id>` → "This link has expired"
 *   - 404 on `/share/<id>` → "Link not found"
 *   - other non-2xx       → friendly fallback containing the status
 *   - `fetch` rejection   → friendly "network error" message
 */
export async function openSharedLink(
    input: string,
    opts: OpenSharedLinkOptions = {},
): Promise<File> {
    const parsed = parseShareInput(input);
    if (!parsed) {
        throw new Error('Invalid share URL or ID.');
    }

    const linkKey = readShareLinkKey(parsed.fragment ?? '');
    if (linkKey.status === 'invalid') {
        throw new Error('Invalid share link: the decryption key is malformed.');
    }

    const apiBase = normalizeBase(opts.apiBase ?? DEFAULT_SHARE_API_BASE);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const version: ShareApiVersion = linkKey.status === 'valid' ? 'v2' : 'v1';

    const ticket = await fetchDownloadTicket(apiBase, version, parsed.shareId, fetchImpl, opts.signal);
    const blob = opts.downloadImpl
        ? await opts.downloadImpl(ticket.download_url, opts.signal)
        : await downloadShareBlob(ticket.download_url, fetchImpl, opts.signal);

    if (linkKey.status === 'valid') {
        let opened: Awaited<ReturnType<typeof decryptShareFile>>;
        try {
            opened = await decryptShareFile(await blob.arrayBuffer(), linkKey.key);
        } catch {
            // Wrong key, tampered or non-encrypted upload: never show it.
            throw new Error('Could not decrypt the shared file. The link may be incomplete or corrupted.');
        }
        const name = sanitizeFilename(opened.meta.filename) || `share-${parsed.shareId}`;
        return new File([opened.bytes], name, {
            type: opened.meta.content_type || 'application/octet-stream',
        });
    }

    const filename = sanitizeFilename(ticket.filename) || `share-${parsed.shareId}`;
    const mime = ticket.mime || blob.type || 'application/octet-stream';

    // Construct a File so the caller's router can dispatch by `.name` /
    // `.type` exactly like a user-picked file.
    return new File([blob], filename, { type: mime });
}

async function fetchDownloadTicket(
    apiBase: string,
    version: ShareApiVersion,
    shareId: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
): Promise<DownloadTicket> {
    const url = `${apiBase}/${version}/shares/${encodeURIComponent(shareId)}/download`;

    let res: Response;
    try {
        res = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal,
        });
    } catch (err) {
        throw new Error(`Network error while opening shared link: ${describeError(err)}`);
    }

    if (res.status === 410) {
        throw new Error('This link has expired.');
    }
    if (res.status === 404) {
        throw new Error('Link not found.');
    }
    if (res.status === 401 || res.status === 403) {
        throw new Error('Access to this shared link was denied.');
    }
    if (!res.ok) {
        const detail = await safeReadError(res);
        throw new Error(
            res.status >= 500
                ? `Share service is unavailable (HTTP ${res.status}). ${detail}`.trim()
                : `Failed to open shared link (HTTP ${res.status}). ${detail}`.trim(),
        );
    }

    let parsed: unknown;
    try {
        parsed = await res.json();
    } catch {
        throw new Error('Invalid response from share endpoint (not JSON).');
    }
    return parseDownloadTicket(parsed, version);
}

async function downloadShareBlob(
    downloadUrl: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
): Promise<Blob> {
    let res: Response;
    try {
        res = await fetchImpl(downloadUrl, { method: 'GET', signal });
    } catch (err) {
        throw new Error(`Network error while downloading shared file: ${describeError(err)}`);
    }

    if (res.status === 410) {
        throw new Error('This link has expired.');
    }
    if (res.status === 404) {
        throw new Error('Link not found.');
    }
    if (!res.ok) {
        throw new Error(`Failed to download shared file (HTTP ${res.status}).`);
    }

    try {
        return await res.blob();
    } catch (err) {
        throw new Error(`Failed to read downloaded file: ${describeError(err)}`);
    }
}

function parseDownloadTicket(parsed: unknown, version: ShareApiVersion): DownloadTicket {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid response from share endpoint (expected JSON object).');
    }
    const obj = parsed as Record<string, unknown>;
    const download_url = pickStringProp(obj, ['download_url', 'downloadUrl', 'url']);
    const filename = pickStringProp(obj, ['filename', 'fileName', 'name']);
    const mime = pickStringProp(obj, ['content_type', 'contentType', 'mime', 'mime_type', 'mimeType']);

    if (!download_url) {
        throw new Error('Invalid share response: missing download_url.');
    }
    // v2 tickets carry no name: it is sealed inside the envelope.
    if (!filename && version === 'v1') {
        throw new Error('Invalid share response: missing filename.');
    }
    return {
        download_url,
        filename: filename ?? '',
        mime: mime ?? '',
    };
}

function pickStringProp(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
}

/**
 * Strip path separators and control characters from a server-supplied
 * filename so it cannot escape the caller's intent (e.g. become a path).
 * We keep the cap modest (200 chars) to match the VSCode build.
 */
function sanitizeFilename(name: string | undefined): string {
    if (!name) return '';
    let cleaned = '';
    for (const ch of name) {
        const code = ch.charCodeAt(0);
        if (ch === '/' || ch === '\\' || code < 0x20) {
            cleaned += '_';
        } else {
            cleaned += ch;
        }
    }
    return cleaned.trim().slice(0, 200);
}
