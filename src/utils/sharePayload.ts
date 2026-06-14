/**
 * Pure helpers for the share-upload flow.
 *
 * These functions are intentionally side-effect free so they can be unit
 * tested without touching the network. The actual orchestration (token
 * fetch + multipart upload + share mint) lives in `src/shareCommand.ts`,
 * which composes these helpers around `fetch`.
 *
 * Policy (matches the VSCode build of Omni Viewer):
 *   - Single file per share.
 *   - Hard 10 MB ceiling on the file body.
 *   - 5 minute server-side expiry (server-controlled; we just record what
 *     the server hands back).
 */

/** Hard ceiling enforced before any network call. */
export const MAX_SHARE_SIZE_BYTES = 10 * 1024 * 1024;

/** Default expiry (minutes) we ask the server to honor. */
export const DEFAULT_SHARE_EXPIRES_IN_MINUTES = 5;

/** The current backend issues IDE upload tokens only for this client id. */
export const SHARE_PLATFORM = 'chrome';

/** Result of {@link validateShareSize}. */
export interface ShareSizeValidation {
    ok: boolean;
    error?: string;
}

/** Successful parse of the `/share` mint endpoint. */
export interface ParsedShareResponse {
    shareId: string;
    expiresAt: string;
    url: string;
}

/** Successful parse of a user-supplied share URL or bare ID. */
export interface ParsedShareInput {
    shareId: string;
}

/**
 * Permissive matcher for the share path segment we mint:
 *   `https://omni-viewer-web.web.app/share/<id>`
 *
 * We accept any host so the helper works against staging/test bases too.
 * The captured group is URL-decoded by the caller.
 */
const SHARE_PATH_PATTERN = /\/(?:share|s)\/([^/?#]+)/;

/**
 * Bare ID format. We deliberately keep this strict (URL-safe characters
 * only) so callers cannot smuggle a stray URL or whitespace through the
 * "raw ID" branch.
 */
const BARE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Recognize either a full share URL (e.g.
 * `https://omni-viewer-web.web.app/share/<id>`) or a bare share ID, and
 * normalize it into `{ shareId }`.
 *
 * Returns `null` if the input is empty / not a string / does not match
 * either accepted form. The caller should surface a friendly error.
 */
export function parseShareInput(input: unknown): ParsedShareInput | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    // URL form: anything containing `/share/<id>` or legacy `/s/<id>`.
    const match = trimmed.match(SHARE_PATH_PATTERN);
    if (match && match[1]) {
        let id = match[1];
        try {
            id = decodeURIComponent(id);
        } catch {
            // Fall back to the raw segment if the URL is malformed.
        }
        // Re-validate the decoded id against the bare-id shape — this
        // rejects pathological inputs like `/s/..%2F..` that decode to a
        // path traversal.
        if (BARE_ID_PATTERN.test(id)) {
            return { shareId: id };
        }
        return null;
    }

    if (BARE_ID_PATTERN.test(trimmed)) {
        return { shareId: trimmed };
    }
    return null;
}

/**
 * Verify a `Blob` / `File` does not exceed the 10 MB share ceiling.
 *
 * Accepts a duck-typed `{ size: number }` so the helper can be exercised in
 * Node-only tests without constructing a real `Blob`.
 */
export function validateShareSize(file: { size: number; name?: string } | null | undefined): ShareSizeValidation {
    if (!file || typeof file.size !== 'number' || Number.isNaN(file.size)) {
        return { ok: false, error: 'No file selected to share.' };
    }
    if (file.size <= 0) {
        return { ok: false, error: 'Cannot share an empty file.' };
    }
    if (file.size > MAX_SHARE_SIZE_BYTES) {
        return {
            ok: false,
            error: `File is too large to share (max ${formatMegabytes(MAX_SHARE_SIZE_BYTES)}, got ${formatMegabytes(file.size)}).`,
        };
    }
    return { ok: true };
}

/**
 * Build the multipart `FormData` body posted to `/share`.
 *
 * Mirrors the VSCode client: includes `platform`, `is_paid_user`, and the
 * raw file bytes. The server signs the request using the JWT obtained from
 * `/upload-token`, so no credentials are placed in the body.
 */
export function buildShareFormData(file: Blob, filename?: string): FormData {
    const fd = new FormData();
    fd.append('platform', SHARE_PLATFORM);
    fd.append('is_paid_user', 'false');
    if (filename) {
        fd.append('file', file, filename);
    } else {
        fd.append('file', file);
    }
    return fd;
}

/**
 * Parse the JSON returned by the `/share` mint endpoint.
 *
 * Accepts either snake_case (server canonical) or camelCase (defensive)
 * shapes. Throws a descriptive `Error` if the payload is missing the
 * required `share_id` / `expires_at` / `download_url` fields.
 */
export function parseShareResponse(json: unknown): ParsedShareResponse {
    if (!json || typeof json !== 'object') {
        throw new Error('Invalid share response: expected JSON object.');
    }
    const obj = json as Record<string, unknown>;

    const shareId = pickString(obj, ['share_id', 'shareId']);
    const expiresAt = pickString(obj, ['expires_at', 'expiresAt']);
    const url = pickString(obj, ['download_url', 'downloadUrl', 'url']);

    if (!shareId) {
        throw new Error('Invalid share response: missing share_id.');
    }
    if (!expiresAt) {
        throw new Error('Invalid share response: missing expires_at.');
    }
    if (!url) {
        throw new Error('Invalid share response: missing download_url.');
    }

    return { shareId, expiresAt, url };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) {
            return v;
        }
    }
    return undefined;
}

function formatMegabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
