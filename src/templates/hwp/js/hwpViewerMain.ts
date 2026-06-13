// HWP/HWPX viewer — iframe-based rhwp-studio integration.
//
// Both .hwp and .hwpx are handled by the locally-vendored rhwp-studio
// (vendor/rhwp-studio/). The studio is embedded in a full-height iframe
// and communicates via postMessage using the @rhwp/editor protocol:
//   request:  { type: 'rhwp-request',  id, method, params }
//   response: { type: 'rhwp-response', id, result, error? }

import { HWP_VIEWER_CSS } from './hwpViewerStyles';

const STYLE_ELEMENT_ID = 'omni-viewer-hwp-styles';

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (!document.getElementById(STYLE_ELEMENT_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ELEMENT_ID;
        style.textContent = HWP_VIEWER_CSS;
        document.head.appendChild(style);
    }
}

function resolveStudioUrl(): string {
    if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
    ) {
        try {
            return chrome.runtime.getURL('vendor/rhwp-studio/index.html');
        } catch {
            // outside extension origin
        }
    }
    return 'vendor/rhwp-studio/index.html';
}

export interface HwpViewerHandle {
    dispose(): void;
}

interface HwpViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    meta: HTMLElement;
    body: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
}

const VIEWER_HTML = /* html */ `
<div class="hv-container" data-hwp-viewer-root>
    <div class="hv-header">
        <div class="hv-title" data-hv-title></div>
        <div class="hv-meta" id="hv-meta"></div>
    </div>
    <div id="hv-loading" class="hv-loading">Loading HWP&hellip;</div>
    <div id="hv-error" class="hv-error" style="display: none;"></div>
    <div id="hv-body" class="hv-body" style="display: none;"></div>
</div>
`;

function resolveDom(container: HTMLElement): HwpViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`hwp viewer: missing DOM node #${id}`);
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-hwp-viewer-root]');
    if (!root) throw new Error('hwp viewer: failed to mount root element');
    const title = root.querySelector<HTMLElement>('[data-hv-title]');
    if (!title) throw new Error('hwp viewer: missing title slot');
    return {
        root,
        title,
        meta: need('hv-meta'),
        body: need('hv-body'),
        loading: need('hv-loading'),
        error: need('hv-error'),
    };
}

function showError(error: HTMLElement, headline: string, detail: string): void {
    error.innerHTML = '';
    const titleEl = document.createElement('div');
    titleEl.className = 'hv-error-title';
    titleEl.textContent = headline;
    const detailEl = document.createElement('div');
    detailEl.className = 'hv-error-detail';
    detailEl.textContent = detail;
    error.append(titleEl, detailEl);
    error.style.display = 'flex';
}

export function mountHwpViewer(file: File, container: HTMLElement): HwpViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;

    let disposed = false;
    let requestId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    const iframe = document.createElement('iframe');
    iframe.src = resolveStudioUrl();
    iframe.style.cssText = 'width:100%;height:calc(100vh - 120px);min-height:500px;border:none;display:block;';
    iframe.allow = 'clipboard-read; clipboard-write';

    const messageHandler = (e: MessageEvent): void => {
        if (e.data?.type === 'rhwp-response' && e.data.id != null) {
            const p = pending.get(e.data.id as number);
            if (p) {
                pending.delete(e.data.id as number);
                if (e.data.error) {
                    p.reject(new Error(e.data.error as string));
                } else {
                    p.resolve(e.data.result);
                }
            }
        }
    };
    window.addEventListener('message', messageHandler);

    const request = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
        new Promise((resolve, reject) => {
            const id = ++requestId;
            pending.set(id, { resolve, reject });
            iframe.contentWindow?.postMessage({ type: 'rhwp-request', id, method, params }, '*');
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`rhwp-studio timeout: ${method}`));
                }
            }, 15000);
        });

    const waitReady = async (): Promise<void> => {
        for (let i = 0; i < 30; i++) {
            try {
                const ok = await request('ready');
                console.log('[hwp] ready response:', ok);
                if (ok) return;
            } catch (e) {
                console.log('[hwp] ready attempt', i, 'failed:', e);
            }
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error('rhwp-studio initialization timeout');
    };

    // Mount iframe into body; override body styles for full-height editor layout.
    dom.body.style.cssText = 'display:flex;flex-direction:column;padding:0;flex:1;min-height:0;overflow:hidden;';
    dom.body.appendChild(iframe);

    void (async () => {
        try {
            // Wait for the iframe DOM to finish loading before sending postMessages.
            await new Promise<void>(resolve => {
                if (iframe.contentDocument?.readyState === 'complete') {
                    resolve();
                } else {
                    iframe.addEventListener('load', () => resolve(), { once: true });
                }
            });
            if (disposed) return;

            await waitReady();
            if (disposed) return;

            const buf = await file.arrayBuffer();
            if (disposed) return;

            const bytes = Array.from(new Uint8Array(buf));
            const result = await request('loadFile', {
                data: bytes,
                fileName: file.name,
                skipUnsavedGuard: true,
            }) as { pageCount: number };

            if (disposed) return;
            const sizeKB = (file.size / 1024).toFixed(1);
            const pages = result.pageCount === 1 ? '1 page' : `${result.pageCount} pages`;
            dom.meta.textContent = `${pages} · ${sizeKB} KB`;
            dom.loading.style.display = 'none';
        } catch (err) {
            if (disposed) return;
            dom.loading.style.display = 'none';
            showError(dom.error, 'HWP 로드 실패', err instanceof Error ? err.message : String(err));
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            window.removeEventListener('message', messageHandler);
            pending.clear();
        },
    };
}

// Exported for tests
export function isHwpxFile(fileName: string): boolean {
    return /\.hwpx$/i.test(fileName);
}

export function formatMeta(pageCount: number, byteLength: number): string {
    const sizeKB = (byteLength / 1024).toFixed(1);
    const pages = pageCount === 1 ? '1 page' : `${pageCount} pages`;
    return `${pages} · ${sizeKB} KB`;
}
