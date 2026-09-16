// src/router.ts — Chrome MV3 routing layer for Omni Viewer.
//
// ---------------------------------------------------------------------------
// Routing strategy (issue #2 decision)
// ---------------------------------------------------------------------------
// We deliberately keep the *single-page* routing model. The top-level
// `viewer.html` continues to host the legacy SPA driven by `src/app.js`, and
// in parallel we expose this module as the new registry-driven dispatcher.
//
// Why not `location.replace('templates/<viewer>/<viewer>Viewer.html?...')`?
// Because the only thing the user owns is a JS `File` handle (from the
// `<input type=file>` or a drag-and-drop event). `File`/`Blob` instances are
// **not structured-cloneable into chrome.storage.session** and they do not
// survive a top-level navigation by URL alone. The two browser-friendly
// options are:
//
//   (a) Keep the file in JS memory and dispatch in-page (this module).
//   (b) Convert the File to a `blob:` URL and pass the URL via query string,
//       then re-fetch the bytes on the destination page. But that means we
//       lose the original `File.name` and `lastModified` metadata unless we
//       also stash a sidecar in `chrome.storage.session`, and the handoff
//       window is fragile (the blob URL must be live when the new page loads).
//
// (a) is simpler, has no storage round-trip, and matches the way the legacy
// SPA already operates. The per-viewer `<viewer>Viewer.html` shells we still
// ship are useful for two reasons:
//
//   1. `chrome://extensions` "Load unpacked" + manual navigation to
//      `templates/<viewer>/<viewer>Viewer.html` gives us a per-viewer dev
//      page (handy for isolated debugging in later issues).
//   2. Future issues that integrate with `chrome.contextMenus` /
//      "Open with…" can route to those pages directly (they will need to
//      pick the file up via a different transport at that point — most
//      likely `chrome.storage.session` keyed by a token, with the blob URL
//      as the actual byte transport — but that handoff is **out of scope
//      for issue #2**).
//
// Net result for #2: the registry, the Provider interface, and the in-page
// dispatcher all exist and route correctly. The legacy `app.js` SPA is
// untouched. The per-viewer HTML shells exist but are wired only as
// thin "load-the-bundle" pages for now.
//
// ---------------------------------------------------------------------------
// File handle transport
// ---------------------------------------------------------------------------
// Within a single page load: in-memory only. `mountViewerForFile` accepts a
// `File` directly and hands it to the matched provider. No serialization is
// needed.
//
// For the *future* per-viewer HTML route, the recommended transport will be:
//   - blob URL via `URL.createObjectURL(file)` passed as `?src=` in the URL,
//   - sidecar metadata (`name`, `size`, `lastModified`, viewType) in
//     `chrome.storage.session` keyed by a random token in `?h=`,
//   - the destination page calls `fetch(src)` to materialize a Blob, then
//     reconstructs a `File` from the blob + metadata.
// This module exposes `prepareHandoff` / `consumeHandoff` helpers as the
// stub of that future transport, but the current dispatch path does not use
// them. They are typed and exported so issue #5 (context menus) can extend
// them without churning the public API.

import {
    OmniViewerViewType,
    ViewerRegistration,
    VIEWER_REGISTRATIONS,
    getRegistrationByViewType,
    getRegistrationBySlug,
    resolveRegistrationByFileName,
    ViewerSlug
} from './viewerRegistry';
import {
    ChromeViewerProvider,
    disposeAllMountedViewers,
    disposeMountedViewer,
    isMountedViewer,
    registerMountedViewer,
    renderUnsupportedFallback
} from './viewerProviderUtils';

let mountGeneration = 0;

export interface RouteResult {
    viewType: OmniViewerViewType;
    registration: ViewerRegistration;
    provider: ChromeViewerProvider;
}

/**
 * Resolve a registration for the given file. Returns `undefined` if no
 * registry entry handles the extension. Pure function — does not touch the
 * DOM.
 */
export function resolveRouteForFile(file: File): ViewerRegistration | undefined {
    return resolveRegistrationByFileName(file.name);
}

/**
 * Resolve a registration by an explicit viewType (e.g. when the caller has
 * already detected the type by signature). Falls back to `undefined` so the
 * caller can render the unsupported state.
 */
export function resolveRouteByViewType(
    viewType: OmniViewerViewType
): ViewerRegistration | undefined {
    return getRegistrationByViewType(viewType);
}

/**
 * Mount the appropriate viewer for `file` into `container`.
 *
 * Behavior:
 *   - clears all previously mounted viewers (calls their `dispose` hooks);
 *   - empties `container`;
 *   - looks up the registry by filename or by the explicit `forceViewType`;
 *   - if no entry matches, renders the unsupported fallback and returns
 *     `undefined`;
 *   - otherwise constructs the provider, calls `render`, registers it for
 *     possible future refresh, and returns the route result.
 */
export async function mountViewerForFile(
    file: File,
    container: HTMLElement,
    options: { forceViewType?: OmniViewerViewType } = {}
): Promise<RouteResult | undefined> {
    const generation = ++mountGeneration;
    disposeAllMountedViewers();
    container.innerHTML = '';

    const registration = options.forceViewType
        ? getRegistrationByViewType(options.forceViewType)
        : resolveRegistrationByFileName(file.name);

    if (!registration) {
        renderUnsupportedFallback(
            container,
            file.name,
            'No registry entry matched this file extension.'
        );
        return undefined;
    }

    const provider = registration.createProvider();
    registerMountedViewer({
        viewType: registration.viewType,
        file,
        container,
        provider
    });

    try {
        await provider.render(file, container);
    } catch (err) {
        if (
            generation !== mountGeneration
            || !isMountedViewer(registration.viewType, file, provider)
        ) return undefined;
        disposeMountedViewer(registration.viewType, file);
        const message = err instanceof Error ? err.message : String(err);
        renderUnsupportedFallback(container, file.name, `Render failed: ${message}`);
        return undefined;
    }

    if (
        generation !== mountGeneration
        || !isMountedViewer(registration.viewType, file, provider)
    ) {
        return undefined;
    }

    return {
        viewType: registration.viewType,
        registration,
        provider
    };
}

// ---------------------------------------------------------------------------
// Per-viewer page handoff stubs (forward-looking; not used by issue #2).
// ---------------------------------------------------------------------------

export interface ViewerHandoffPayload {
    /** Stable identifier for the handoff record. */
    token: string;
    /** Resolved viewType. */
    viewType: OmniViewerViewType;
    /** `URL.createObjectURL(file)` — only valid in the originating document. */
    blobUrl: string;
    /** File metadata that does not survive `blob:` URL alone. */
    fileMeta: {
        name: string;
        size: number;
        lastModified: number;
        type: string;
    };
}

const SESSION_STORAGE_KEY_PREFIX = 'omniViewer.handoff.';

function generateToken(): string {
    // 96 bits of randomness, base36-encoded, fine for an in-process correlator.
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a handoff payload for a future per-viewer page navigation. This is a
 * stub: it constructs the URL and (when available) writes metadata to
 * `chrome.storage.session`. It does **not** navigate. Issue #5 will wire
 * navigation; issue #2 only needs the symbol to exist.
 */
export async function prepareHandoff(
    file: File,
    viewType: OmniViewerViewType
): Promise<ViewerHandoffPayload> {
    const token = generateToken();
    const blobUrl = URL.createObjectURL(file);
    const payload: ViewerHandoffPayload = {
        token,
        viewType,
        blobUrl,
        fileMeta: {
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            type: file.type
        }
    };

    // `chrome.storage.session` may be unavailable when the page is opened
    // outside the extension origin (e.g. during local previews). Guard it.
    const session = getSessionStorage();
    if (session) {
        try {
            await session.set({
                [SESSION_STORAGE_KEY_PREFIX + token]: {
                    viewType: payload.viewType,
                    fileMeta: payload.fileMeta
                }
            });
        } catch {
            // Best-effort: a missing session store should not block dispatch.
        }
    }

    return payload;
}

function getSessionStorage(): chrome.storage.SessionStorageArea | undefined {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
        return undefined;
    }
    return chrome.storage.session;
}

/**
 * Read a handoff record back from `chrome.storage.session`. The blob URL is
 * **not** stored — it must be passed via the URL `?src=` parameter.
 */
export async function consumeHandoff(
    token: string
): Promise<Omit<ViewerHandoffPayload, 'blobUrl'> | undefined> {
    const session = getSessionStorage();
    if (!session) {
        return undefined;
    }
    const key = SESSION_STORAGE_KEY_PREFIX + token;
    const result = await session.get(key);
    const record = result[key] as
        | { viewType: OmniViewerViewType; fileMeta: ViewerHandoffPayload['fileMeta'] }
        | undefined;
    if (!record) {
        return undefined;
    }
    await session.remove(key);
    return { token, viewType: record.viewType, fileMeta: record.fileMeta };
}

/**
 * Build a fully-qualified per-viewer page URL. Used by future navigation
 * code; exposed here so the URL shape lives next to the rest of the routing
 * contract.
 */
export function buildViewerPageUrl(
    slug: ViewerSlug,
    payload: ViewerHandoffPayload
): string {
    const params = new URLSearchParams();
    params.set('h', payload.token);
    params.set('src', payload.blobUrl);
    return `templates/${slug}/${slug}Viewer.html?${params.toString()}`;
}

/**
 * Re-export a couple of registry-level helpers so consumers only need to
 * import `./router`.
 */
export {
    VIEWER_REGISTRATIONS,
    getRegistrationByViewType,
    getRegistrationBySlug
};
export type { OmniViewerViewType, ViewerRegistration, ViewerSlug };
