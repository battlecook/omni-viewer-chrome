// Chrome-flavored port of the VSCode `viewerProviderUtils.ts` module.
//
// The VSCode original deals with `vscode.WebviewPanel`, `vscode.CustomDocument`,
// active editor tabs, refreshable panels, etc. None of that exists in a Chrome
// MV3 extension page. What survives the port is a much smaller surface:
//
//   1. The shape of the per-viewer "Provider" (a render function over a File).
//   2. The unsupported / error fallback HTML rendering.
//   3. A tiny refresh registry so a future "Refresh" action can rebind the
//      currently-mounted viewer (the parallel of `refreshActiveViewer`).
//
// All `vscode.*` imports were stripped. This module is browser-only.

import type { OmniViewerViewType } from './viewerRegistry';

/**
 * Minimal context handed to per-viewer providers when they render.
 *
 * The VSCode original carried `ExtensionContext`, `CustomDocument`, and the
 * `WebviewPanel`. In the Chrome page we only need:
 *   - the file the user dropped / picked,
 *   - the DOM container the viewer should mount into,
 *   - the resolved viewType (so providers can branch if they handle multiple).
 */
export interface ViewerProviderContext {
    file: File;
    container: HTMLElement;
    viewType: OmniViewerViewType;
}

/**
 * Chrome-side Provider interface. A registry entry's `createProvider` returns
 * one of these. The page (router) calls `render` after mounting.
 *
 * `dispose` is optional and is called when the page tears the viewer down
 * (e.g. user picks a new file or navigates away).
 */
export interface ChromeViewerProvider {
    render(file: File, container: HTMLElement): void | Promise<void>;
    dispose?(): void;
}

export interface ViewerErrorContent {
    title: string;
    message: string;
    icon: string;
    lang?: string;
}

/**
 * In-page registry of mountable viewers, keyed by viewType. This is the
 * Chrome equivalent of `refreshableViewers` in the VSCode original. It does
 * not survive a hard navigation (location.replace) — see `src/router.ts` for
 * the routing strategy notes.
 */
interface MountedViewer {
    viewType: OmniViewerViewType;
    file: File;
    container: HTMLElement;
    provider: ChromeViewerProvider;
}

const mountedViewers = new Map<string, MountedViewer>();

function getMountKey(viewType: OmniViewerViewType, file: File): string {
    return `${viewType}:${file.name}:${file.size}:${file.lastModified}`;
}

export function registerMountedViewer(mounted: MountedViewer): void {
    mountedViewers.set(getMountKey(mounted.viewType, mounted.file), mounted);
}

export function disposeMountedViewer(viewType: OmniViewerViewType, file: File): void {
    const key = getMountKey(viewType, file);
    const mounted = mountedViewers.get(key);
    if (mounted) {
        mounted.provider.dispose?.();
        mountedViewers.delete(key);
    }
}

export function disposeAllMountedViewers(): void {
    for (const mounted of mountedViewers.values()) {
        mounted.provider.dispose?.();
    }
    mountedViewers.clear();
}

/**
 * `renderUnsupported` parallels the VSCode `renderErrorHtml` function. The
 * router calls this when no registry entry matches the detected viewType, or
 * when the viewer fails to load.
 *
 * This implementation injects DOM directly into the container instead of
 * returning an HTML string, which is the more idiomatic browser-side pattern.
 */
export function renderUnsupported(
    container: HTMLElement,
    fileName: string,
    errorMessage: string,
    content: ViewerErrorContent
): void {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'omni-viewer-error';
    wrapper.setAttribute('role', 'alert');
    wrapper.setAttribute('lang', content.lang || 'en');

    const icon = document.createElement('div');
    icon.className = 'omni-viewer-error-icon';
    icon.textContent = content.icon;

    const title = document.createElement('div');
    title.className = 'omni-viewer-error-title';
    title.textContent = content.title;

    const message = document.createElement('div');
    message.className = 'omni-viewer-error-message';
    message.textContent = content.message;

    const file = document.createElement('div');
    file.className = 'omni-viewer-error-filename';
    file.textContent = fileName;

    const detail = document.createElement('div');
    detail.className = 'omni-viewer-error-detail';
    detail.textContent = errorMessage;

    wrapper.append(icon, title, message, file, detail);
    container.appendChild(wrapper);
}

/**
 * Convenience: the standard "no viewer for this file" fallback.
 */
export function renderUnsupportedFallback(
    container: HTMLElement,
    fileName: string,
    reason: string
): void {
    renderUnsupported(container, fileName, reason, {
        title: 'Unsupported file',
        message: 'No viewer is registered for this file type.',
        icon: '!'
    });
}
