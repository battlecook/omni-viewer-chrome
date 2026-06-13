import { VIEWER_REGISTRATIONS } from '../../../viewerRegistry';
import type { ChromeViewerProvider } from '../../../viewerProviderUtils';
import { mountMarkdownViewer, MarkdownViewerHandle } from './markdownViewerMain';

export { mountMarkdownViewer };
export type { MarkdownViewerHandle };

function createMarkdownProvider(): ChromeViewerProvider {
    let handle: MarkdownViewerHandle | undefined;
    return {
        async render(file: File, container: HTMLElement): Promise<void> {
            handle?.dispose();
            handle = await mountMarkdownViewer(file, container);
        },
        dispose(): void {
            handle?.dispose();
            handle = undefined;
        }
    };
}

const registration = VIEWER_REGISTRATIONS.find(
    (entry) => entry.viewType === 'omni-viewer.markdownViewer'
);
if (registration) registration.createProvider = createMarkdownProvider;

declare global {
    interface Window {
        __omniMountMarkdown?: typeof mountMarkdownViewer;
    }
}

if (typeof window !== 'undefined') window.__omniMountMarkdown = mountMarkdownViewer;

async function selfBootstrap(): Promise<void> {
    const host = document.querySelector<HTMLElement>('[data-viewer="markdown"]');
    const src = new URLSearchParams(window.location.search).get('src');
    if (!host || !src) return;
    try {
        const response = await fetch(src);
        const blob = await response.blob();
        const name = src.startsWith('data:')
            ? 'document.md'
            : decodeURIComponent(src.split('/').pop() || 'document.md');
        await mountMarkdownViewer(new File([blob], name, {
            type: blob.type || 'text/markdown'
        }), host);
    } catch (error) {
        host.textContent = `Failed to load Markdown: ${errorMessage(error)}`;
    }
}

if (typeof document !== 'undefined' && document.querySelector('[data-viewer="markdown"]')) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void selfBootstrap());
    } else {
        void selfBootstrap();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
