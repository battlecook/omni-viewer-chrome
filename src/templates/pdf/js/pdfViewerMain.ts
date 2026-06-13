// Orchestration layer for the Chrome PDF viewer.
//
// Wires together:
//   - DOM scaffolding (toolbar / zoom controls / page-info / scroll port /
//     thumbnail sidebar shell / overlay layer placeholder),
//   - the pdf.js renderer (`./pdfRenderer.ts`),
//   - the discrete zoom ladder (`./pdfZoom.ts`),
//   - the per-page indicator wired to the renderer's
//     `onCurrentPageChanged` callback.
//
// VSCode -> Chrome substitutions follow the same rules as #9 / #33:
//   - the file is a `File` from the router; we call `await
//     file.arrayBuffer()` to get the raw bytes and pass them as
//     `data: Uint8Array` to pdf.js (the VSCode original passes a
//     base64-decoded buffer).
//   - the worker URL is `chrome.runtime.getURL('vendor/pdf.worker.min.mjs')`
//     (resolved inside `pdfRenderer.ts`).
//   - `vscode.postMessage` is dropped; we log to console instead.
//
// Scope is locked to issue #16: render / zoom / page indicator / scroll.
// Anything else (annotations, save, thumbnails, password modal, ...) is
// left as a stub with a `TODO #<issue>` comment so the next issue's PR
// has an obvious anchor.

import { applyDocumentLocale, t } from '../../../utils/i18n';
import { PDF_VIEWER_CSS } from './pdfViewerStyles';
import { mountPdfRenderer, PdfRendererHandle } from './pdfRenderer';
import { mountThumbnails, ThumbnailHandle } from './thumbnail';
import {
    PageOrderState,
    deletePage as deletePageInOrder,
    isModified as isOrderModified,
    reorder as reorderPages,
    resetOrder
} from './pageOrder';
import {
    PasswordModalDom,
    PasswordPromptHandle,
    attachPasswordPrompt,
    isAbortedPdfLoad,
    reasonFromPdfJsResponse
} from './pdfPassword';
import {
    ZOOM_LEVELS_PERCENT,
    DEFAULT_ZOOM_PERCENT,
    formatZoomLabel,
    percentToScale,
    zoomInStep,
    zoomOutStep,
    canZoomIn,
    canZoomOut
} from './pdfZoom';
import {
    createPdfAnnotationStore,
    PdfAnnotationStore
} from './pdfAnnotationStore';
import {
    DEFAULT_TEXT_ANNOTATION_COLOR,
    DEFAULT_TEXT_ANNOTATION_SIZE,
    TextAnnotationModeHandle,
    attachTextAnnotationMode,
    renderTextAnnotations
} from './annotations/text';
import {
    DEFAULT_SIGNATURE_COLOR,
    DEFAULT_SIGNATURE_HEIGHT,
    DEFAULT_SIGNATURE_WIDTH,
    SignatureAnnotationModeHandle,
    SignaturePadHandle,
    attachSignatureAnnotationMode,
    attachSignaturePad,
    renderSignatureAnnotations
} from './annotations/signature';
import {
    SelectionHandle,
    attachSelectionLayer
} from './annotations/selection';
import {
    buildSavedPdfBlob,
    defaultSavedFilename,
    persistBlobToDisk
} from './save';
import { mergePdf, pickPdfBytes } from './merge';

const STYLE_ELEMENT_ID = 'omni-viewer-pdf-styles';

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = PDF_VIEWER_CSS;
    document.head.appendChild(style);
}

interface TextAnnotationModalDom {
    modal: HTMLElement;
    textInput: HTMLTextAreaElement;
    sizeInput: HTMLInputElement;
    colorInput: HTMLInputElement;
    confirmBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
}

interface SignatureAnnotationModalDom {
    modal: HTMLElement;
    canvas: HTMLCanvasElement;
    colorInput: HTMLInputElement;
    clearBtn: HTMLButtonElement;
    confirmBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
}

interface PdfViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    pageInfo: HTMLElement;
    zoomLevel: HTMLElement;
    zoomInBtn: HTMLButtonElement;
    zoomOutBtn: HTMLButtonElement;
    viewBtn: HTMLButtonElement;
    textAnnotationBtn: HTMLButtonElement;
    signatureAnnotationBtn: HTMLButtonElement;
    resetOrderBtn: HTMLButtonElement;
    mergeBtn: HTMLButtonElement;
    saveBtn: HTMLButtonElement;
    saveAsBtn: HTMLButtonElement;
    body: HTMLElement;
    pdfContainer: HTMLElement;
    pagesContainer: HTMLElement;
    thumbnailSidebar: HTMLElement;
    thumbnailList: HTMLElement;
    overlayLayer: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
    passwordModal: PasswordModalDom;
    textAnnotationModal: TextAnnotationModalDom;
    signatureAnnotationModal: SignatureAnnotationModalDom;
}

export interface PdfViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="pv-container" data-pdf-viewer-root>
    <div class="pv-header">
        <div class="pv-title" data-pv-title></div>
        <div class="pv-toolbar">
            <button type="button" id="pv-viewBtn" class="pv-toolbar-btn is-active" title="View / move annotations" aria-pressed="true">👁 View</button>
            <button type="button" id="pv-textAnnotationBtn" class="pv-toolbar-btn" title="Add text annotation" aria-pressed="false">📝 Text</button>
            <button type="button" id="pv-signatureAnnotationBtn" class="pv-toolbar-btn" title="Add signature" aria-pressed="false">✍ Signature</button>
            <button type="button" id="pv-resetOrderBtn" class="pv-toolbar-btn" title="Reset page order" disabled>↺ Reset</button>
            <button type="button" id="pv-mergeBtn" class="pv-toolbar-btn" title="Append another PDF">🔗 Merge PDF</button>
            <button type="button" id="pv-saveBtn" class="pv-toolbar-btn" title="Save (Ctrl/Cmd+S)">💾 Save</button>
            <button type="button" id="pv-saveAsBtn" class="pv-toolbar-btn" title="Save As…">📁 Save As</button>

            <span class="pv-page-info" id="pv-pageInfo">1 / 1</span>
        </div>
    </div>
    <div class="pv-zoom-controls">
        <button type="button" id="pv-zoomOut" class="pv-icon-btn" title="Zoom out">−</button>
        <span id="pv-zoomLevel" class="pv-zoom-level">100%</span>
        <button type="button" id="pv-zoomIn" class="pv-icon-btn" title="Zoom in">+</button>
    </div>
    <div id="pv-loading" class="pv-loading">Loading PDF…</div>
    <div id="pv-error" class="pv-error" style="display: none;"></div>
    <div id="pv-passwordModal" class="pv-modal" style="display: none;">
        <div class="pv-modal-content">
            <label id="pv-passwordPromptLabel" class="pv-modal-label" for="pv-passwordInput">Enter PDF password:</label>
            <input type="password" id="pv-passwordInput" class="pv-modal-input" placeholder="Password" autocomplete="off" />
            <div id="pv-passwordHint" class="pv-modal-hint" style="display: none;"></div>
            <div class="pv-modal-actions">
                <button type="button" id="pv-passwordConfirm" class="pv-btn pv-btn-primary">Open PDF</button>
                <button type="button" id="pv-passwordCancel" class="pv-btn">Cancel</button>
            </div>
        </div>
    </div>
    <div id="pv-textAnnotationModal" class="pv-modal" style="display: none;">
        <div class="pv-modal-content">
            <label class="pv-modal-label" for="pv-textAnnotationText">Add text annotation:</label>
            <textarea id="pv-textAnnotationText" class="pv-modal-textarea" placeholder="Type annotation text" rows="3"></textarea>
            <div class="pv-modal-row">
                <label for="pv-textAnnotationSize">Size</label>
                <input type="number" id="pv-textAnnotationSize" class="pv-modal-input" min="6" max="144" step="1" />
            </div>
            <div class="pv-modal-row">
                <label for="pv-textAnnotationColor">Color</label>
                <input type="color" id="pv-textAnnotationColor" class="pv-modal-input" />
            </div>
            <div class="pv-modal-actions">
                <button type="button" id="pv-textAnnotationConfirm" class="pv-btn pv-btn-primary">Add</button>
                <button type="button" id="pv-textAnnotationCancel" class="pv-btn">Cancel</button>
            </div>
        </div>
    </div>
    <div id="pv-signatureAnnotationModal" class="pv-modal" style="display: none;">
        <div class="pv-modal-content pv-modal-content-wide">
            <label class="pv-modal-label">Draw your signature:</label>
            <div class="pv-signature-canvas-wrap">
                <canvas id="pv-signatureCanvas" width="400" height="180"></canvas>
            </div>
            <div class="pv-modal-row">
                <label for="pv-signatureColor">Color</label>
                <input type="color" id="pv-signatureColor" class="pv-modal-input" />
                <button type="button" id="pv-signatureClear" class="pv-btn pv-signature-clear">Clear</button>
            </div>
            <div class="pv-modal-actions">
                <button type="button" id="pv-signatureConfirm" class="pv-btn pv-btn-primary">Add</button>
                <button type="button" id="pv-signatureCancel" class="pv-btn">Cancel</button>
            </div>
        </div>
    </div>
    <div id="pv-pdfBody" class="pv-body" style="display: none;">
        <!-- Two-pane layout (issue #86): thumbnails on the left, document on
             the right. Each pane is its own scroll container so clicking a
             thumbnail moves the document only — the sidebar stays put. -->
        <aside id="pv-thumbnailSidebar" class="pv-thumbnail-sidebar" aria-label="Page thumbnails">
            <div class="pv-thumbnail-help">Preview only until Save/Save As. Drag to reorder pages, × to delete a page, or select an annotation and press Delete.</div>
            <div id="pv-thumbnailList" class="pv-thumbnail-list"></div>
        </aside>
        <section id="pv-pdfContainer" class="pv-pdf-container" aria-label="PDF document">
            <div id="pv-pagesContainer" class="pv-pages-container"></div>
            <!-- Selection overlay layered on top of text / signature annotations -->
            <div id="pv-overlayLayer" class="pv-overlay-layer"></div>
        </section>
    </div>
</div>
`;

function resolveDom(container: HTMLElement): PdfViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) throw new Error(`pdf viewer: missing DOM node #${id}`);
        return el;
    };
    const root = container.querySelector<HTMLElement>(
        '[data-pdf-viewer-root]'
    );
    if (!root) throw new Error('pdf viewer: failed to mount root element');
    const title = root.querySelector<HTMLElement>('[data-pv-title]');
    if (!title) throw new Error('pdf viewer: missing title slot');
    return {
        root,
        title,
        pageInfo: need('pv-pageInfo'),
        zoomLevel: need('pv-zoomLevel'),
        zoomInBtn: need<HTMLButtonElement>('pv-zoomIn'),
        zoomOutBtn: need<HTMLButtonElement>('pv-zoomOut'),
        viewBtn: need<HTMLButtonElement>('pv-viewBtn'),
        body: need('pv-pdfBody'),
        pdfContainer: need('pv-pdfContainer'),
        pagesContainer: need('pv-pagesContainer'),
        thumbnailSidebar: need('pv-thumbnailSidebar'),
        thumbnailList: need('pv-thumbnailList'),
        overlayLayer: need('pv-overlayLayer'),
        loading: need('pv-loading'),
        error: need('pv-error'),
        passwordModal: {
            modal: need('pv-passwordModal'),
            label: need('pv-passwordPromptLabel'),
            hint: need('pv-passwordHint'),
            input: need<HTMLInputElement>('pv-passwordInput'),
            confirmBtn: need<HTMLButtonElement>('pv-passwordConfirm'),
            cancelBtn: need<HTMLButtonElement>('pv-passwordCancel')
        },
        textAnnotationBtn: need<HTMLButtonElement>('pv-textAnnotationBtn'),
        textAnnotationModal: {
            modal: need('pv-textAnnotationModal'),
            textInput: need<HTMLTextAreaElement>('pv-textAnnotationText'),
            sizeInput: need<HTMLInputElement>('pv-textAnnotationSize'),
            colorInput: need<HTMLInputElement>('pv-textAnnotationColor'),
            confirmBtn: need<HTMLButtonElement>('pv-textAnnotationConfirm'),
            cancelBtn: need<HTMLButtonElement>('pv-textAnnotationCancel')
        },
        signatureAnnotationBtn: need<HTMLButtonElement>('pv-signatureAnnotationBtn'),
        resetOrderBtn: need<HTMLButtonElement>('pv-resetOrderBtn'),
        mergeBtn: need<HTMLButtonElement>('pv-mergeBtn'),
        saveBtn: need<HTMLButtonElement>('pv-saveBtn'),
        saveAsBtn: need<HTMLButtonElement>('pv-saveAsBtn'),
        signatureAnnotationModal: {
            modal: need('pv-signatureAnnotationModal'),
            canvas: need<HTMLCanvasElement>('pv-signatureCanvas'),
            colorInput: need<HTMLInputElement>('pv-signatureColor'),
            clearBtn: need<HTMLButtonElement>('pv-signatureClear'),
            confirmBtn: need<HTMLButtonElement>('pv-signatureConfirm'),
            cancelBtn: need<HTMLButtonElement>('pv-signatureCancel')
        }
    };
}

interface TextAnnotationFormValues {
    text: string;
    size: number;
    color: string;
}

interface TextAnnotationPromptHandle {
    show(defaults: TextAnnotationFormValues): Promise<TextAnnotationFormValues | undefined>;
    hide(): void;
    dispose(): void;
}

/**
 * Wrap the text-annotation modal in a promise-based prompt, mirroring the
 * password modal's UX (Confirm / Cancel / Esc / Enter, focus on open).
 */
function attachTextAnnotationPrompt(
    dom: TextAnnotationModalDom
): TextAnnotationPromptHandle {
    let pending: ((value: TextAnnotationFormValues | undefined) => void) | undefined;

    const close = (result: TextAnnotationFormValues | undefined): void => {
        dom.modal.style.display = 'none';
        const resolver = pending;
        pending = undefined;
        if (resolver) resolver(result);
    };

    const handleConfirm = (): void => {
        if (!pending) return;
        const text = dom.textInput.value;
        if (!text.trim()) {
            dom.textInput.focus();
            return;
        }
        const size = parseFloat(dom.sizeInput.value);
        const safeSize = Number.isFinite(size) && size > 0 ? size : DEFAULT_TEXT_ANNOTATION_SIZE;
        const color = dom.colorInput.value || DEFAULT_TEXT_ANNOTATION_COLOR;
        close({ text, size: safeSize, color });
    };

    const handleCancel = (): void => {
        if (!pending) return;
        close(undefined);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
        if (!pending) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
            return;
        }
        // Cmd/Ctrl+Enter confirms from inside the textarea so plain Enter
        // can still insert newlines in multi-line annotations.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            handleConfirm();
        }
    };

    const handleSimpleKeyDown = (event: KeyboardEvent): void => {
        if (!pending) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            handleConfirm();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
        }
    };

    dom.confirmBtn.addEventListener('click', handleConfirm);
    dom.cancelBtn.addEventListener('click', handleCancel);
    dom.textInput.addEventListener('keydown', handleKeyDown);
    dom.sizeInput.addEventListener('keydown', handleSimpleKeyDown);
    dom.colorInput.addEventListener('keydown', handleSimpleKeyDown);

    return {
        show(defaults: TextAnnotationFormValues): Promise<TextAnnotationFormValues | undefined> {
            // Resolve any in-flight prompt as cancelled before re-opening.
            if (pending) {
                const resolver = pending;
                pending = undefined;
                resolver(undefined);
            }
            dom.textInput.value = defaults.text;
            dom.sizeInput.value = String(defaults.size);
            dom.colorInput.value = defaults.color;
            dom.modal.style.display = 'flex';
            // Focus on next microtask so display:flex has paint-applied.
            Promise.resolve().then(() => {
                dom.textInput.focus();
                dom.textInput.select();
            });
            return new Promise<TextAnnotationFormValues | undefined>((resolve) => {
                pending = resolve;
            });
        },
        hide(): void {
            if (!pending && dom.modal.style.display === 'none') return;
            close(undefined);
        },
        dispose(): void {
            dom.confirmBtn.removeEventListener('click', handleConfirm);
            dom.cancelBtn.removeEventListener('click', handleCancel);
            dom.textInput.removeEventListener('keydown', handleKeyDown);
            dom.sizeInput.removeEventListener('keydown', handleSimpleKeyDown);
            dom.colorInput.removeEventListener('keydown', handleSimpleKeyDown);
            if (pending) {
                const resolver = pending;
                pending = undefined;
                resolver(undefined);
            }
            dom.modal.style.display = 'none';
        }
    };
}

interface SignatureAnnotationFormValues {
    /** PNG data URL of the signed canvas. */
    dataUrl: string;
    /** CSS hex of the ink color the user picked. */
    color: string;
}

interface SignatureAnnotationPromptHandle {
    show(defaults: { color: string }): Promise<SignatureAnnotationFormValues | undefined>;
    hide(): void;
    dispose(): void;
}

/**
 * Wrap the signature-annotation modal in a promise-based prompt. The
 * modal owns a signature pad (`attachSignaturePad`) for the lifetime of
 * the viewer; opening the modal just resets the canvas + color input.
 */
function attachSignatureAnnotationPrompt(
    dom: SignatureAnnotationModalDom
): SignatureAnnotationPromptHandle {
    const pad = attachSignaturePad({
        canvas: dom.canvas,
        initialColor: DEFAULT_SIGNATURE_COLOR
    });
    // The pad exposes `setColor` via a hidden cast — reach for it once
    // here so the modal can drive the color picker.
    const padWithColor = pad as SignaturePadHandle & { setColor?(next: string): void };

    let pending: ((value: SignatureAnnotationFormValues | undefined) => void) | undefined;

    const close = (result: SignatureAnnotationFormValues | undefined): void => {
        dom.modal.style.display = 'none';
        const resolver = pending;
        pending = undefined;
        if (resolver) resolver(result);
    };

    const handleConfirm = (): void => {
        if (!pending) return;
        if (!pad.hasInk()) {
            // Nothing drawn — keep modal open so the user can sign.
            return;
        }
        const dataUrl = pad.toDataUrl();
        if (!dataUrl) return;
        const color = dom.colorInput.value || DEFAULT_SIGNATURE_COLOR;
        close({ dataUrl, color });
    };

    const handleCancel = (): void => {
        if (!pending) return;
        close(undefined);
    };

    const handleClear = (): void => {
        pad.clear();
    };

    const handleColorChange = (): void => {
        const next = dom.colorInput.value || DEFAULT_SIGNATURE_COLOR;
        if (padWithColor.setColor) {
            padWithColor.setColor(next);
        }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
        if (!pending) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
        }
    };

    dom.confirmBtn.addEventListener('click', handleConfirm);
    dom.cancelBtn.addEventListener('click', handleCancel);
    dom.clearBtn.addEventListener('click', handleClear);
    dom.colorInput.addEventListener('input', handleColorChange);
    dom.colorInput.addEventListener('change', handleColorChange);
    dom.modal.addEventListener('keydown', handleKeyDown);

    return {
        show(defaults: { color: string }): Promise<SignatureAnnotationFormValues | undefined> {
            // Resolve any in-flight prompt as cancelled before re-opening.
            if (pending) {
                const resolver = pending;
                pending = undefined;
                resolver(undefined);
            }
            pad.clear();
            dom.colorInput.value = defaults.color;
            if (padWithColor.setColor) {
                padWithColor.setColor(defaults.color);
            }
            dom.modal.style.display = 'flex';
            return new Promise<SignatureAnnotationFormValues | undefined>((resolve) => {
                pending = resolve;
            });
        },
        hide(): void {
            if (!pending && dom.modal.style.display === 'none') return;
            close(undefined);
        },
        dispose(): void {
            dom.confirmBtn.removeEventListener('click', handleConfirm);
            dom.cancelBtn.removeEventListener('click', handleCancel);
            dom.clearBtn.removeEventListener('click', handleClear);
            dom.colorInput.removeEventListener('input', handleColorChange);
            dom.colorInput.removeEventListener('change', handleColorChange);
            dom.modal.removeEventListener('keydown', handleKeyDown);
            pad.dispose();
            if (pending) {
                const resolver = pending;
                pending = undefined;
                resolver(undefined);
            }
            dom.modal.style.display = 'none';
        }
    };
}

/**
 * Mount the PDF viewer into `container`. Returns synchronously with a
 * handle whose `dispose()` cleans up; the actual pdf.js load happens in
 * the background and the loading / error UI reacts to it.
 */
export function mountPdfViewer(file: File, container: HTMLElement): PdfViewerHandle {
    ensureStylesInjected();
    applyDocumentLocale();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    dom.title.textContent = file.name;
    dom.zoomLevel.textContent = formatZoomLabel(DEFAULT_ZOOM_PERCENT);
    // Localize toolbar / modals / static labels.
    dom.viewBtn.title = t('pdfViewTitle', dom.viewBtn.title || 'View / move annotations');
    dom.textAnnotationBtn.title = t('pdfTextAnnotationTitle', dom.textAnnotationBtn.title || 'Add text annotation');
    dom.loading.textContent = t('pdfLoading', 'Loading PDF…');

    let zoomPercent = DEFAULT_ZOOM_PERCENT;
    let renderer: PdfRendererHandle | undefined;
    let thumbnails: ThumbnailHandle | undefined;
    let disposed = false;
    let unsubscribePage: (() => void) | undefined;
    // Issue #23 — keep the bytes used to bootstrap the renderer around so
    // Save / Save As can re-load them through pdf-lib without re-fetching
    // from disk, and so Merge can hand them to `mergePdf`.
    let currentBytes: Uint8Array | undefined;
    // Source filename — defaults to `file.name` but is updated in place
    // on Merge so subsequent saves carry a meaningful suggested name.
    let currentName = file.name;
    // Re-mount guard. After a Merge, the `mountPdfViewer` helper is
    // re-invoked from within the previous handle. The previous handle is
    // disposed first, so this flag flips and any in-flight async work
    // (e.g. the async load chain in this very mount) bails out.
    let remounted = false;

    // Issue #22 — preview-only page order state. The original PDF is not
    // touched until save (#23). `pageOrder.order` is an array of 1-based
    // *original* page numbers in their current visible order.
    let pageOrder: PageOrderState = resetOrder(0);

    // Annotation store + text-mode handle. The store is created up-front
    // so the toolbar button can drive it immediately, even before pdf.js
    // has resolved (the button just won't drop anything because there are
    // no page wrappers yet).
    const annotationStore: PdfAnnotationStore = createPdfAnnotationStore();
    const textPrompt = attachTextAnnotationPrompt(dom.textAnnotationModal);
    const signaturePrompt = attachSignatureAnnotationPrompt(dom.signatureAnnotationModal);
    let lastTextSize = DEFAULT_TEXT_ANNOTATION_SIZE;
    let lastTextColor = DEFAULT_TEXT_ANNOTATION_COLOR;
    let lastSignatureColor = DEFAULT_SIGNATURE_COLOR;
    let textMode: TextAnnotationModeHandle | undefined;
    let signatureMode: SignatureAnnotationModeHandle | undefined;
    let selection: SelectionHandle | undefined;
    let unsubscribeStore: (() => void) | undefined;
    type ToolMode = 'view' | 'text' | 'signature';
    let toolMode: ToolMode = 'view';

    const repaintAnnotations = (): void => {
        const scale = percentToScale(zoomPercent);
        renderTextAnnotations({
            overlayLayer: dom.overlayLayer,
            pagesContainer: dom.pagesContainer,
            store: annotationStore,
            scale
        });
        renderSignatureAnnotations({
            overlayLayer: dom.overlayLayer,
            pagesContainer: dom.pagesContainer,
            store: annotationStore,
            scale
        });
    };

    const setToolMode = (next: ToolMode): void => {
        toolMode = next;
        const isView = next === 'view';
        const isText = next === 'text';
        const isSignature = next === 'signature';

        if (textMode) {
            if (isText) textMode.enable();
            else textMode.disable();
        }
        if (signatureMode) {
            if (isSignature) signatureMode.enable();
            else signatureMode.disable();
        }
        if (selection) {
            if (isView && !selection.isEnabled()) selection.enable();
            if (!isView && selection.isEnabled()) selection.disable();
        }

        const states: Array<[HTMLButtonElement, boolean]> = [
            [dom.viewBtn, isView],
            [dom.textAnnotationBtn, isText],
            [dom.signatureAnnotationBtn, isSignature]
        ];
        for (const [button, active] of states) {
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
    };

    const onViewButtonClick = (): void => setToolMode('view');
    const onTextAnnotationButtonClick = (): void => setToolMode('text');
    const onSignatureAnnotationButtonClick = (): void => setToolMode('signature');

    dom.viewBtn.addEventListener('click', onViewButtonClick);
    dom.textAnnotationBtn.addEventListener('click', onTextAnnotationButtonClick);
    dom.signatureAnnotationBtn.addEventListener('click', onSignatureAnnotationButtonClick);

    // Password prompt: pdf.js calls our `onPasswordRequired` when it sees an
    // encrypted PDF or rejects an incorrect password. We bridge that to a
    // promise resolved by the modal's confirm button.
    let pendingPasswordResolve: ((pw: string) => void) | undefined;
    let pendingPasswordReject: (() => void) | undefined;
    const passwordPrompt: PasswordPromptHandle = attachPasswordPrompt(
        dom.passwordModal,
        (pw) => {
            const r = pendingPasswordResolve;
            pendingPasswordResolve = undefined;
            pendingPasswordReject = undefined;
            if (r) r(pw);
        },
        () => {
            const r = pendingPasswordReject;
            pendingPasswordResolve = undefined;
            pendingPasswordReject = undefined;
            if (r) r();
        }
    );

    const onPasswordRequired = (reasonCode: number): Promise<string> => {
        return new Promise<string>((resolve, reject) => {
            pendingPasswordResolve = resolve;
            pendingPasswordReject = reject;
            passwordPrompt.show(reasonFromPdfJsResponse(reasonCode));
        });
    };

    const updateZoomButtonsEnabled = (): void => {
        dom.zoomInBtn.disabled = !canZoomIn(zoomPercent);
        dom.zoomOutBtn.disabled = !canZoomOut(zoomPercent);
    };

    const updatePageInfo = (current: number, total: number): void => {
        dom.pageInfo.textContent = `${current} / ${total}`;
    };

    const onZoomIn = (): void => {
        const next = zoomInStep(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        dom.zoomLevel.textContent = formatZoomLabel(zoomPercent);
        updateZoomButtonsEnabled();
        if (renderer) {
            void renderer.setScale(percentToScale(zoomPercent)).then(() => {
                if (!disposed) repaintAnnotations();
            });
        } else {
            repaintAnnotations();
        }
    };

    const onZoomOut = (): void => {
        const next = zoomOutStep(zoomPercent);
        if (next === zoomPercent) return;
        zoomPercent = next;
        dom.zoomLevel.textContent = formatZoomLabel(zoomPercent);
        updateZoomButtonsEnabled();
        if (renderer) {
            void renderer.setScale(percentToScale(zoomPercent)).then(() => {
                if (!disposed) repaintAnnotations();
            });
        } else {
            repaintAnnotations();
        }
    };

    dom.zoomInBtn.addEventListener('click', onZoomIn);
    dom.zoomOutBtn.addEventListener('click', onZoomOut);
    updateZoomButtonsEnabled();

    // --- Issue #22: page order state + DOM sync ----------------------
    //
    // We never touch the renderer's internal page records — instead, we
    // sync three things off `pageOrder`:
    //   1. The pages-container reorders / hides `.pv-page-wrapper` nodes
    //      so the user sees the new visible order.
    //   2. The thumbnail sidebar refreshes via `thumbnails.refresh()`.
    //   3. The "Reset" button is enabled iff `pageOrder` is modified.
    const applyPageOrderToDom = (): void => {
        const wrappers = Array.from(
            dom.pagesContainer.querySelectorAll<HTMLElement>(
                '.pv-page-wrapper[data-page-number]'
            )
        );
        const wrapperByPage = new Map<number, HTMLElement>();
        for (const w of wrappers) {
            const pn = Number(w.dataset.pageNumber);
            if (Number.isInteger(pn)) wrapperByPage.set(pn, w);
        }
        const visible = new Set<number>(pageOrder.order);
        // Hide deleted page wrappers; show all others.
        for (const w of wrappers) {
            const pn = Number(w.dataset.pageNumber);
            if (!Number.isInteger(pn)) continue;
            w.style.display = visible.has(pn) ? '' : 'none';
        }
        // Reorder by re-appending in the order described by `pageOrder.order`.
        // `appendChild` of an existing node moves it; this preserves
        // event listeners and any rendered canvas inside.
        for (const pn of pageOrder.order) {
            const w = wrapperByPage.get(pn);
            if (w) dom.pagesContainer.appendChild(w);
        }
    };

    const updateResetButtonState = (): void => {
        dom.resetOrderBtn.disabled = !isOrderModified(pageOrder);
    };

    const refreshAfterOrderChange = (): void => {
        applyPageOrderToDom();
        if (thumbnails) thumbnails.refresh();
        updateResetButtonState();
        // Annotations are page-bound; repaint so their positions track
        // any wrapper re-layout.
        repaintAnnotations();
        selection?.refresh();
    };

    const onReorderPages = (fromIdx: number, toIdx: number): void => {
        const next = reorderPages(pageOrder, fromIdx, toIdx);
        if (next === pageOrder) return;
        pageOrder = next;
        refreshAfterOrderChange();
    };

    const onDeletePageAt = (idx: number): void => {
        const next = deletePageInOrder(pageOrder, idx);
        if (next === pageOrder) return; // last-page guard hit a no-op
        pageOrder = next;
        refreshAfterOrderChange();
    };

    const onResetOrder = (): void => {
        if (!isOrderModified(pageOrder)) return;
        pageOrder = resetOrder(pageOrder.numPages);
        refreshAfterOrderChange();
    };

    dom.resetOrderBtn.addEventListener('click', onResetOrder);

    // --- Issue #23: Merge / Save / Save As --------------------------
    //
    // Save and Save As both go through the same composite (`buildSavedPdfBlob`
    // + `persistBlobToDisk`). The only difference is the suggested filename:
    // Save uses `<name>-edited.pdf` once, Save As does the same but never
    // tries to overwrite — extension pages have no "current path" to
    // overwrite anyway, so the picker is always invoked.
    //
    // Merge: pick a second PDF, append it to the current one with pdf-lib,
    // then *re-mount* this very viewer with the merged bytes. We can't just
    // patch the live pdf.js render — the merged document has a new page
    // count, new page objects, and new internal cross-references.
    let saveBusy = false;
    const handleSaveOrSaveAs = async (): Promise<void> => {
        if (saveBusy) return;
        if (!currentBytes) return; // load hasn't finished yet
        saveBusy = true;
        const prevSaveLabel = dom.saveBtn.textContent;
        const prevSaveAsLabel = dom.saveAsBtn.textContent;
        dom.saveBtn.disabled = true;
        dom.saveAsBtn.disabled = true;
        try {
            const blob = await buildSavedPdfBlob({
                bytes: currentBytes,
                pageOrder,
                store: annotationStore
            });
            await persistBlobToDisk(blob, defaultSavedFilename(currentName));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('pdf save failed:', err);
            window.alert(`Failed to save PDF: ${message}`);
        } finally {
            saveBusy = false;
            dom.saveBtn.disabled = false;
            dom.saveAsBtn.disabled = false;
            dom.saveBtn.textContent = prevSaveLabel;
            dom.saveAsBtn.textContent = prevSaveAsLabel;
        }
    };

    const onSaveClick = (): void => {
        void handleSaveOrSaveAs();
    };
    const onSaveAsClick = (): void => {
        void handleSaveOrSaveAs();
    };

    let mergeBusy = false;
    const onMergeClick = async (): Promise<void> => {
        if (mergeBusy) return;
        if (!currentBytes) return;
        mergeBusy = true;
        dom.mergeBtn.disabled = true;
        try {
            const picked = await pickPdfBytes();
            if (!picked) return;
            if (disposed) return;
            const merged = await mergePdf({
                currentBytes,
                addBytes: picked
            });
            if (disposed) return;
            // In-place re-mount: build a synthetic File from the merged
            // bytes and call `mountPdfViewer` again on the same container.
            // We mark `remounted = true` so this handle's `dispose` skips
            // the renderer/thumbnails teardown that the new mount has
            // already replaced via `container.innerHTML = VIEWER_HTML`.
            const mergedFile = new File([merged], currentName, {
                type: 'application/pdf'
            });
            remounted = true;
            // Tear down listeners we own on this handle's DOM (the
            // container is about to be re-templated).
            disposeOwnState();
            mountPdfViewer(mergedFile, container);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('pdf merge failed:', err);
            window.alert(`Failed to merge PDF: ${message}`);
        } finally {
            mergeBusy = false;
            if (!remounted) dom.mergeBtn.disabled = false;
        }
    };
    const onMergeBtnClick = (): void => {
        void onMergeClick();
    };

    // Ctrl/Cmd+S triggers Save. The capture phase listener swallows the
    // browser's "save page" default before the document-level handler
    // sees it. We attach to `window` so the shortcut works regardless of
    // which sub-element has focus.
    const onWindowKeyDown = (event: KeyboardEvent): void => {
        const isSaveCombo =
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            (event.key === 's' || event.key === 'S');
        if (!isSaveCombo) return;
        event.preventDefault();
        event.stopPropagation();
        void handleSaveOrSaveAs();
    };

    dom.saveBtn.addEventListener('click', onSaveClick);
    dom.saveAsBtn.addEventListener('click', onSaveAsClick);
    dom.mergeBtn.addEventListener('click', onMergeBtnClick);
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', onWindowKeyDown, true);
    }

    // Kick off the async load. Errors land in the inline error panel.
    void (async () => {
        try {
            const arrayBuf = await file.arrayBuffer();
            if (disposed) return;
            const bytes = new Uint8Array(arrayBuf);
            currentBytes = bytes;

            renderer = await mountPdfRenderer({
                pagesContainer: dom.pagesContainer,
                scrollContainer: dom.pdfContainer,
                bytes,
                initialScale: percentToScale(zoomPercent),
                onPasswordRequired
            });
            if (disposed) {
                renderer.dispose();
                renderer = undefined;
                return;
            }

            const total = renderer.numPages;
            const initialPage = renderer.getCurrentPageNumber();
            updatePageInfo(initialPage, total);

            // Issue #22 — seed the page-order state with identity now
            // that we know the page count.
            pageOrder = resetOrder(total);
            updateResetButtonState();

            // Issue #17 — mount the thumbnail sidebar. Click-to-jump and
            // (issue #22) drag-and-drop reorder + delete.
            const rendererHandle = renderer;
            thumbnails = mountThumbnails({
                sidebar: dom.thumbnailSidebar,
                list: dom.thumbnailList,
                scrollContainer: dom.pdfContainer,
                pagesContainer: dom.pagesContainer,
                numPages: total,
                getPage: (n) => rendererHandle.getPage(n),
                getOrder: () => pageOrder.order,
                onReorder: onReorderPages,
                onDelete: onDeletePageAt
            });
            thumbnails.setActivePage(initialPage);

            unsubscribePage = renderer.onCurrentPageChanged((current) => {
                updatePageInfo(current, total);
                if (thumbnails) {
                    thumbnails.setActivePage(current);
                }
            });

            dom.loading.style.display = 'none';
            // Issue #86 — `.pv-body` uses `display: grid` for the two-pane
            // sidebar/document layout. The inline `display: none` on the
            // template hides it during load; clear that override here so
            // the stylesheet's grid value takes effect.
            dom.body.style.display = '';

            // Wire text-mode click capture now that the page wrappers
            // exist. The store-change listener repaints the overlay so the
            // newly-dropped annotation shows up after the modal closes.
            textMode = attachTextAnnotationMode({
                pagesContainer: dom.pagesContainer,
                getScale: () => percentToScale(zoomPercent),
                onClick: ({ pageIndex, x, y }) => {
                    void (async () => {
                        const result = await textPrompt.show({
                            text: '',
                            size: lastTextSize,
                            color: lastTextColor
                        });
                        if (disposed) return;
                        if (!result) return;
                        lastTextSize = result.size;
                        lastTextColor = result.color;
                        annotationStore.addAnnotation({
                            kind: 'text',
                            pageIndex,
                            x,
                            y,
                            text: result.text,
                            size: result.size,
                            color: result.color
                        });
                    })();
                }
            });
            signatureMode = attachSignatureAnnotationMode({
                pagesContainer: dom.pagesContainer,
                getScale: () => percentToScale(zoomPercent),
                onClick: ({ pageIndex, x, y }) => {
                    void (async () => {
                        const result = await signaturePrompt.show({
                            color: lastSignatureColor
                        });
                        if (disposed) return;
                        if (!result) return;
                        lastSignatureColor = result.color;
                        annotationStore.addAnnotation({
                            kind: 'signature',
                            pageIndex,
                            x,
                            y,
                            dataUrl: result.dataUrl,
                            width: DEFAULT_SIGNATURE_WIDTH,
                            height: DEFAULT_SIGNATURE_HEIGHT
                        });
                    })();
                }
            });
            // Selection / drag / delete manager (issue #21). Mounted
            // before the store-change listener so the listener's repaint
            // can be followed by `selection.refresh()` (the selected
            // annotation's DOM node is rebuilt on every repaint).
            selection = attachSelectionLayer({
                store: annotationStore,
                overlayLayer: dom.overlayLayer,
                getCurrentScale: () => percentToScale(zoomPercent)
            });
            setToolMode(toolMode);
            // Ensure overlay receives pointer events for the selection
            // path. (`pv-overlay-layer` defaults to `pointer-events: none`
            // so the canvas underneath stays interactive; we let
            // individual annotation nodes opt back in via `pointer-events:
            // auto`, which they already do.)

            unsubscribeStore = annotationStore.onChange(() => {
                if (!disposed) {
                    repaintAnnotations();
                    selection?.refresh();
                }
            });
            // First paint in case the store is pre-populated (future
            // session-restore hook).
            repaintAnnotations();
            selection.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            dom.loading.style.display = 'none';
            // User cancelled the password modal -> we already destroyed the
            // loading task, so the rejection surfaces here as an aborted load.
            // Treat that as a benign close, not an error to display.
            if (isAbortedPdfLoad(err)) {
                dom.error.style.display = 'block';
                dom.error.textContent = t('pdfLoadCancelled', 'PDF load was cancelled.');
            } else {
                dom.error.style.display = 'block';
                dom.error.textContent = t('pdfLoadFailed', `Failed to load PDF: ${message}`, message);
            }
        }
    })();

    function disposeOwnState(): void {
        disposed = true;
        dom.zoomInBtn.removeEventListener('click', onZoomIn);
        dom.zoomOutBtn.removeEventListener('click', onZoomOut);
        dom.viewBtn.removeEventListener('click', onViewButtonClick);
        dom.textAnnotationBtn.removeEventListener('click', onTextAnnotationButtonClick);
        dom.signatureAnnotationBtn.removeEventListener('click', onSignatureAnnotationButtonClick);
        dom.resetOrderBtn.removeEventListener('click', onResetOrder);
        dom.saveBtn.removeEventListener('click', onSaveClick);
        dom.saveAsBtn.removeEventListener('click', onSaveAsClick);
        dom.mergeBtn.removeEventListener('click', onMergeBtnClick);
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', onWindowKeyDown, true);
        }
        if (unsubscribePage) {
            try {
                unsubscribePage();
            } catch {
                // best-effort
            }
            unsubscribePage = undefined;
        }
        if (unsubscribeStore) {
            try {
                unsubscribeStore();
            } catch {
                // best-effort
            }
            unsubscribeStore = undefined;
        }
        if (textMode) {
            textMode.dispose();
            textMode = undefined;
        }
        if (signatureMode) {
            signatureMode.dispose();
            signatureMode = undefined;
        }
        if (selection) {
            selection.dispose();
            selection = undefined;
        }
        textPrompt.dispose();
        signaturePrompt.dispose();
        if (thumbnails) {
            thumbnails.dispose();
            thumbnails = undefined;
        }
        if (renderer) {
            renderer.dispose();
            renderer = undefined;
        }
        // Reject any pending password promise so the loading task tear-down
        // doesn't leave a dangling promise on the heap.
        if (pendingPasswordReject) {
            const r = pendingPasswordReject;
            pendingPasswordResolve = undefined;
            pendingPasswordReject = undefined;
            r();
        }
        passwordPrompt.hide();
    }

    return {
        dispose(): void {
            disposeOwnState();
        }
    };
}

// Re-export the canonical zoom ladder so downstream issues can reference
// it without reimporting the helper module.
export { ZOOM_LEVELS_PERCENT };
