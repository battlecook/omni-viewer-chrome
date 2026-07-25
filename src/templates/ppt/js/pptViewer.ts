// PowerPoint viewer entry — Chrome adapter over omni-viewer-core.
import {
    mountPptViewer as mountCorePptViewer,
    type PptViewerHandle
} from 'omni-viewer-core/viewers/ppt';
import type { HostContext } from 'omni-viewer-core/host';
import { resolveCatalogMessage } from 'omni-viewer-core/i18n';

function context(): HostContext {
    const chromeI18n = typeof chrome !== 'undefined' && chrome.i18n?.getMessage
        ? chrome.i18n : undefined;
    return {
        assets: { resolveAssetUrl: async (path) =>
            typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path },
        i18n: { t: (key, args) => chromeI18n?.getMessage(key.replace(/[.-]/g, '_')) || resolveCatalogMessage(key, args) },
        logger: { log: (level, message) => console[level === 'info' ? 'info' : level]('[omni-viewer ppt]', message) }
    };
}

function isEditableTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element || typeof element.tagName !== 'string') return false;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true;
    return element.isContentEditable;
}

/** Restore the Chrome viewer's slide-navigation shortcuts around core's
 * public controller. Zoom shortcuts remain owned by core. */
export function installPptKeyboardNavigation(
    container: HTMLElement,
    handle: PptViewerHandle
): () => void {
    if (handle.mode !== 'slides') return () => undefined;

    const onKeydown = (event: KeyboardEvent): void => {
        if (isEditableTarget(event.target)) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        let action: 'previous' | 'next' | undefined;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
            action = 'previous';
        } else if (
            event.key === 'ArrowRight'
            || event.key === 'ArrowDown'
            || event.key === 'PageDown'
            || event.key === ' '
        ) {
            action = 'next';
        }
        if (!action) return;

        event.preventDefault();
        handle.controller.dispatch({ type: action });
        if (handle.controller.state.mode === 'continuous') {
            const root = container.shadowRoot ?? container;
            const currentSlide = root.querySelector<HTMLElement>(
                `[aria-label="Slide ${handle.controller.state.currentSlide}"]`
            );
            currentSlide?.scrollIntoView?.({ block: 'start' });
        }
    };

    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
}

export async function mountPptViewer(file: File, container: HTMLElement): Promise<PptViewerHandle> {
    const handle = await mountCorePptViewer(
        { fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified },
        container,
        context()
    );
    const removeKeyboardNavigation = installPptKeyboardNavigation(container, handle);
    let disposed = false;
    return {
        controller: handle.controller,
        mode: handle.mode,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            removeKeyboardNavigation();
            handle.dispose();
        }
    };
}

declare global { interface Window { __omniMountPpt?: typeof mountPptViewer; } }
if (typeof window !== 'undefined') window.__omniMountPpt = mountPptViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="ppt"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = decodeURIComponent(src.split('/').pop() || 'presentation.pptx');
        await mountPptViewer(new File([blob], name, {
            type: blob.type || 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }), host);
    } catch (error) {
        host.textContent = `Failed to load PowerPoint document: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="ppt"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
