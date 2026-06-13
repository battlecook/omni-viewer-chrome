/**
 * Browser-flavored share-upload orchestrator.
 *
 * Equivalent to `shareCommand.ts` in the VSCode build, but uses `fetch`
 * and `FormData` instead of Node's `https`. The flow:
 *
 *   1. Validate the file against the 10 MB ceiling (no network call).
 *   2. POST `/upload-token` -> short-lived JWT.
 *   3. POST multipart `/share` with `Authorization: Bearer <jwt>`.
 *   4. Parse the response into `{ shareId, expiresAt, url }`.
 *
 * This module deliberately does NOT wire any UI; #67 is responsible for
 * hooking the share buttons to call `shareFile`. We keep `shareFile`
 * pure-ish (returns a `Promise<ShareResult>`, throws `Error` on failure)
 * so the caller chooses how to surface errors.
 */

import {
    MAX_SHARE_SIZE_BYTES,
    ParsedShareResponse,
    buildShareFormData,
    parseShareInput,
    parseShareResponse,
    validateShareSize,
} from './utils/sharePayload';

/** Default share API base. Inject `apiBase` to override (e.g. tests, staging). */
export const DEFAULT_SHARE_API_BASE = 'https://omni-viewer-share.example.com';

/** Public options accepted by {@link shareFile}. */
export interface ShareFileOptions {
    /** Override the API base URL. Trailing slashes are tolerated. */
    apiBase?: string;
    /** Override the filename sent to the server (defaults to `file.name`). */
    filename?: string;
    /**
     * Optional `fetch` override. Mostly useful for tests that want to stub
     * the network without monkey-patching `globalThis.fetch`.
     */
    fetchImpl?: typeof fetch;
    /** Optional abort signal forwarded to every underlying `fetch` call. */
    signal?: AbortSignal;
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
 *   - upload-token endpoint 401 / 5xx / non-JSON
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

    const token = await fetchUploadToken(apiBase, fetchImpl, opts.signal);
    const minted = await postShare(apiBase, token, file, filename, fetchImpl, opts.signal);

    return {
        ...minted,
        filename,
        size: file.size,
    };
}

// --- internals ----------------------------------------------------------

async function fetchUploadToken(
    apiBase: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
): Promise<string> {
    let res: Response;
    try {
        res = await fetchImpl(`${apiBase}/upload-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: 'chrome' }),
            signal,
        });
    } catch (err) {
        throw new Error(`Network error while requesting upload token: ${describeError(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
        throw new Error('Share upload was rejected (authentication failed).');
    }
    if (!res.ok) {
        const detail = await safeReadError(res);
        throw new Error(
            res.status >= 500
                ? `Share service is unavailable (HTTP ${res.status}). ${detail}`.trim()
                : `Failed to obtain upload token (HTTP ${res.status}). ${detail}`.trim(),
        );
    }

    let parsed: unknown;
    try {
        parsed = await res.json();
    } catch {
        throw new Error('Invalid response from upload-token endpoint (not JSON).');
    }

    const token = extractToken(parsed);
    if (!token) {
        throw new Error('Invalid response from upload-token endpoint (missing token).');
    }
    return token;
}

async function postShare(
    apiBase: string,
    token: string,
    file: Blob,
    filename: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
): Promise<ParsedShareResponse> {
    const fd = buildShareFormData(file, filename);

    let res: Response;
    try {
        res = await fetchImpl(`${apiBase}/share`, {
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

function extractToken(parsed: unknown): string | undefined {
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    for (const key of ['upload_token', 'uploadToken', 'token', 'jwt']) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
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
}

/** Server-issued ticket describing a shared file we are allowed to download. */
interface DownloadTicket {
    download_url: string;
    filename: string;
    mime: string;
}

/**
 * Resolve a share URL or bare share ID into a downloadable `File`.
 *
 * Steps:
 *   1. Parse the input (URL or raw ID) into `{ shareId }`.
 *   2. `GET <apiBase>/share/<id>` to fetch the download ticket
 *      (`{ download_url, filename, mime }`).
 *   3. Download the file bytes from `download_url`.
 *   4. Wrap them in a `File` so the caller can hand it directly to the
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

    const apiBase = normalizeBase(opts.apiBase ?? DEFAULT_SHARE_API_BASE);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

    const ticket = await fetchDownloadTicket(apiBase, parsed.shareId, fetchImpl, opts.signal);
    const blob = await downloadShareBlob(ticket.download_url, fetchImpl, opts.signal);

    const filename = sanitizeFilename(ticket.filename) || `share-${parsed.shareId}`;
    const mime = ticket.mime || blob.type || 'application/octet-stream';

    // Construct a File so the caller's router can dispatch by `.name` /
    // `.type` exactly like a user-picked file.
    return new File([blob], filename, { type: mime });
}

async function fetchDownloadTicket(
    apiBase: string,
    shareId: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
): Promise<DownloadTicket> {
    const url = `${apiBase}/share/${encodeURIComponent(shareId)}`;

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
    return parseDownloadTicket(parsed);
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

function parseDownloadTicket(parsed: unknown): DownloadTicket {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid response from share endpoint (expected JSON object).');
    }
    const obj = parsed as Record<string, unknown>;
    const download_url = pickStringProp(obj, ['download_url', 'downloadUrl', 'url']);
    const filename = pickStringProp(obj, ['filename', 'fileName', 'name']);
    const mime = pickStringProp(obj, ['mime', 'mime_type', 'mimeType', 'content_type', 'contentType']);

    if (!download_url) {
        throw new Error('Invalid share response: missing download_url.');
    }
    if (!filename) {
        throw new Error('Invalid share response: missing filename.');
    }
    return {
        download_url,
        filename,
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
