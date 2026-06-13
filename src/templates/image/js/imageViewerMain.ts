// Orchestration layer for the image viewer.
//
// This file is the Chrome-side port of
// `vscode-omni-viewer/src/templates/image/js/imageViewerMain.js`. It owns:
//   - the DOM wiring (querying control buttons, info spans, the <img> tag),
//   - the imperative event-listener hookup (clicks + keyboard shortcuts),
//   - the transform state and the `image.style.transform` re-render.
//
// All math/state helpers live in `./imageUtils.ts` and are imported here.
//
// VSCode -> Chrome substitutions:
//   - `acquireVsCodeApi()` / `vscode.postMessage` -> dropped. Logs go to
//     `console`; there is no host bridge in a Chrome extension page.
//   - The image source previously came from `webview.asWebviewUri`; in the
//     Chrome port the caller (router) hands us a `File`, and we use
//     `URL.createObjectURL(file)` as the `<img src>`. `dispose` revokes
//     the URL so the blob is GC-eligible.
//   - File size + format come from the live `File` object instead of the
//     `{{fileSize}}` / `{{fileName}}` template substitutions.
//
// Edit-mode + filters + save (the right half of the VSCode original) are
// intentionally NOT ported here. Issue #9 only covers zoom/rotate/flip/fit
// and the file-info panel. The HTML keeps the relevant placeholder buttons
// (toggleEditMode, saveFiltered, etc.) hidden so the layout stays
// diff-friendly with the VSCode source.

import {
    ImageTransform,
    createIdentityTransform,
    rotate,
    flipHorizontal,
    flipVertical,
    zoomIn,
    zoomOut,
    setScale,
    computeFitToScreenScale,
    transformToCss,
    getImageFormatFromFile,
    formatFileSize
} from './imageUtils';
import {
    FilterValues,
    FilterPresetName,
    FILTER_PRESETS,
    IDENTITY_FILTER_VALUES,
    applyPreset,
    buildFilterString,
    clampFilterValue,
    detectMatchingPreset
} from './imageFilters';
import { IMAGE_VIEWER_CSS } from './imageViewerStyles';
import { mountImageEditMode, ImageEditModeHandle } from './ImageEditMode';
import {
    composeEditedImage,
    canvasToBlob,
    saveBlob,
    defaultEditedFilename
} from './imageSave';

const STYLE_ELEMENT_ID = 'omni-viewer-image-styles';

/**
 * Inject the viewer stylesheet once per document. The router mounts the
 * viewer into the legacy SPA's host page, and that page does NOT load
 * `src/templates/image/css/imageViewer.css`. Bundling the CSS into the JS
 * module avoids touching webpack config (forbidden by issue #9 guardrails)
 * and avoids fighting the legacy SPA's stylesheet ordering.
 */
function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = IMAGE_VIEWER_CSS;
    document.head.appendChild(style);
}

/**
 * Set of DOM nodes the orchestrator owns. Resolved once in `mountImageViewer`.
 * IDs match the VSCode original 1:1 (see issue #9 step 1).
 */
interface ImageViewerDom {
    root: HTMLElement;
    image: HTMLImageElement;
    imageWrapper: HTMLElement;
    imageContainer: HTMLElement;
    loading: HTMLElement;
    error: HTMLElement;
    fileInfo: HTMLElement;
    sizeInfo: HTMLElement;
    formatInfo: HTMLElement;
    fileSizeInfo: HTMLElement;
    rotateBtn: HTMLButtonElement;
    flipHorizontalBtn: HTMLButtonElement;
    flipVerticalBtn: HTMLButtonElement;
    resetBtn: HTMLButtonElement;
    fitToScreenBtn: HTMLButtonElement;
    zoomOutBtn: HTMLButtonElement;
    zoomInBtn: HTMLButtonElement;
    presetBtns: Record<FilterPresetName, HTMLButtonElement>;
    sliders: Record<keyof FilterValues, HTMLInputElement>;
    sliderValues: Record<keyof FilterValues, HTMLElement>;
    toggleEditModeBtn: HTMLButtonElement;
    saveBtn: HTMLButtonElement;
    editModeHost: HTMLElement;
    filenameModal: HTMLElement;
    filenameInput: HTMLInputElement;
    filenameModalConfirm: HTMLButtonElement;
    filenameModalCancel: HTMLButtonElement;
}

/** Public mount handle. Caller (router/provider) gets a `dispose()`. */
export interface ImageViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="iv-container" data-image-viewer-root>
    <div class="iv-main-content">
        <div class="iv-file-info" id="fileInfo" style="display: none;">
            <div class="iv-file-info-item">
                <div class="iv-file-info-label">Size</div>
                <div class="iv-file-info-value" id="sizeInfo">--</div>
            </div>
            <div class="iv-file-info-item">
                <div class="iv-file-info-label">Format</div>
                <div class="iv-file-info-value" id="formatInfo">--</div>
            </div>
            <div class="iv-file-info-item">
                <div class="iv-file-info-label">File Size</div>
                <div class="iv-file-info-value" id="fileSizeInfo">--</div>
            </div>
        </div>

        <div class="iv-controls">
            <div class="iv-control-group">
                <button id="rotate" class="iv-btn" type="button" title="Rotate 90° (←/→)">🔄</button>
            </div>
            <div class="iv-control-group">
                <button id="flipHorizontal" class="iv-btn" type="button" title="Flip horizontal">↔️</button>
                <button id="flipVertical" class="iv-btn" type="button" title="Flip vertical">↕️</button>
            </div>
            <div class="iv-control-group">
                <button id="reset" class="iv-btn" type="button" title="Reset (R)">⏹️ Reset</button>
                <button id="fitToScreen" class="iv-btn" type="button" title="Fit (0)">📐 Fit</button>
                <button id="zoomOut" class="iv-btn" type="button" title="Zoom out (-)">🔍-</button>
                <button id="zoomIn" class="iv-btn" type="button" title="Zoom in (+)">🔍+</button>
            </div>
            <div class="iv-control-group">
                <button id="toggleEditMode" class="iv-btn" type="button" title="Toggle edit mode">✏️ Edit</button>
                <button id="saveImage" class="iv-btn" type="button" title="Save (Ctrl+S)">💾 Save</button>
            </div>
        </div>

        <div id="filenameModal" class="iv-modal-overlay" style="display: none;" role="dialog" aria-modal="true" aria-label="Save image">
            <div class="iv-modal">
                <div class="iv-modal-title">Save image</div>
                <label for="filenameInput" class="iv-modal-label">Filename</label>
                <input id="filenameInput" type="text" class="iv-modal-input" autocomplete="off" spellcheck="false">
                <div class="iv-modal-actions">
                    <button id="cancelSave" type="button" class="iv-btn">Cancel</button>
                    <button id="confirmSave" type="button" class="iv-btn iv-btn--primary">Save</button>
                </div>
            </div>
        </div>

        <div id="editModeHost" class="iv-edit-mode-host"></div>

        <div class="iv-filter-controls">
            <div class="iv-filter-presets">
                <button id="presetNormal" class="iv-preset-btn is-active" type="button">Original</button>
                <button id="presetBright" class="iv-preset-btn" type="button">Bright</button>
                <button id="presetDark" class="iv-preset-btn" type="button">Dark</button>
                <button id="presetVintage" class="iv-preset-btn" type="button">Vintage</button>
                <button id="presetBw" class="iv-preset-btn" type="button">B&amp;W</button>
            </div>
            <div class="iv-filter-sliders">
                <div class="iv-filter-group">
                    <label for="brightnessSlider">Brightness</label>
                    <input type="range" id="brightnessSlider" class="iv-filter-slider" min="0" max="200" step="5" value="100">
                    <span id="brightnessValue" class="iv-filter-value">100%</span>
                </div>
                <div class="iv-filter-group">
                    <label for="contrastSlider">Contrast</label>
                    <input type="range" id="contrastSlider" class="iv-filter-slider" min="0" max="200" step="5" value="100">
                    <span id="contrastValue" class="iv-filter-value">100%</span>
                </div>
                <div class="iv-filter-group">
                    <label for="saturationSlider">Saturation</label>
                    <input type="range" id="saturationSlider" class="iv-filter-slider" min="0" max="200" step="5" value="100">
                    <span id="saturationValue" class="iv-filter-value">100%</span>
                </div>
                <div class="iv-filter-group">
                    <label for="grayscaleSlider">Grayscale</label>
                    <input type="range" id="grayscaleSlider" class="iv-filter-slider" min="0" max="100" step="5" value="0">
                    <span id="grayscaleValue" class="iv-filter-value">0%</span>
                </div>
            </div>
        </div>

        <div class="iv-image-container">
            <div id="loading" class="iv-loading">Loading image...</div>
            <div id="error" class="iv-error" style="display: none;"></div>
            <div id="imageWrapper" class="iv-image-wrapper" style="display: none;">
                <img id="image" alt="">
            </div>
        </div>
    </div>
</div>
`;

/**
 * Render the image viewer into `container` for the given `File`. Returns a
 * handle whose `dispose()` revokes the blob URL and removes the DOM tree.
 *
 * The function is structured as: build DOM -> resolve refs -> attach
 * listeners -> assign `<img src>`. The image's `onload` is what flips
 * `#imageWrapper` to `display: block` (per issue #9 step 5).
 */
export function mountImageViewer(file: File, container: HTMLElement): ImageViewerHandle {
    ensureStylesInjected();
    container.innerHTML = VIEWER_HTML;

    const dom = resolveDom(container);
    const blobUrl = URL.createObjectURL(file);

    let transform: ImageTransform = createIdentityTransform();
    let filterValues: FilterValues = { ...IDENTITY_FILTER_VALUES };

    const renderTransform = (): void => {
        dom.image.style.transform = transformToCss(transform);
    };

    const renderFilters = (): void => {
        dom.image.style.filter = buildFilterString(filterValues);
        (Object.keys(dom.sliderValues) as Array<keyof FilterValues>).forEach((channel) => {
            dom.sliderValues[channel].textContent = `${filterValues[channel]}%`;
        });
        const matched = detectMatchingPreset(filterValues);
        (Object.keys(dom.presetBtns) as FilterPresetName[]).forEach((name) => {
            dom.presetBtns[name].classList.toggle('is-active', matched === name);
        });
    };

    const syncSlidersFromValues = (): void => {
        (Object.keys(dom.sliders) as Array<keyof FilterValues>).forEach((channel) => {
            dom.sliders[channel].value = String(filterValues[channel]);
        });
    };

    const fitToScreen = (): void => {
        const cw = dom.imageContainer.clientWidth;
        const ch = dom.imageContainer.clientHeight;
        const nw = dom.image.naturalWidth;
        const nh = dom.image.naturalHeight;
        const scale = computeFitToScreenScale(cw, ch, nw, nh);
        transform = setScale(transform, scale);
        renderTransform();
    };

    const updateInfo = (): void => {
        dom.sizeInfo.textContent = `${dom.image.naturalWidth}×${dom.image.naturalHeight}`;
        dom.formatInfo.textContent = getImageFormatFromFile(file) || '--';
        dom.fileSizeInfo.textContent = formatFileSize(file.size);
    };

    const reset = (): void => {
        transform = createIdentityTransform();
        filterValues = { ...IDENTITY_FILTER_VALUES };
        syncSlidersFromValues();
        renderTransform();
        renderFilters();
    };

    // --- listeners --------------------------------------------------------
    const onRotate = () => {
        transform = rotate(transform, 90);
        renderTransform();
    };
    const onFlipH = () => {
        transform = flipHorizontal(transform);
        renderTransform();
    };
    const onFlipV = () => {
        transform = flipVertical(transform);
        renderTransform();
    };
    const onReset = () => reset();
    const onFit = () => fitToScreen();
    const onZoomIn = () => {
        transform = zoomIn(transform);
        renderTransform();
    };
    const onZoomOut = () => {
        transform = zoomOut(transform);
        renderTransform();
    };

    dom.rotateBtn.addEventListener('click', onRotate);
    dom.flipHorizontalBtn.addEventListener('click', onFlipH);
    dom.flipVerticalBtn.addEventListener('click', onFlipV);
    dom.resetBtn.addEventListener('click', onReset);
    dom.fitToScreenBtn.addEventListener('click', onFit);
    dom.zoomInBtn.addEventListener('click', onZoomIn);
    dom.zoomOutBtn.addEventListener('click', onZoomOut);

    // --- edit mode (issue #11) -------------------------------------------
    // Mount the edit-mode shell + ToolManager. The panel is appended to
    // `editModeHost` and starts hidden. Clicking #toggleEditMode flips
    // panel visibility via the handle's `toggle()`. Element creation /
    // selection / save land in #12-#15 and will subscribe to
    // `editMode.toolManager` without touching this orchestrator.
    const editMode: ImageEditModeHandle = mountImageEditMode({
        host: dom.editModeHost,
        // Mount the auto-built `.iv-edit-canvas` over the image wrapper so
        // its `position: absolute; inset: 0;` aligns the click coordinates
        // with the displayed image.
        canvasHost: dom.imageWrapper,
        onToggle: (enabled) => {
            dom.toggleEditModeBtn.classList.toggle('is-active', enabled);
        }
    });
    const onToggleEditMode = () => {
        editMode.toggle();
    };
    dom.toggleEditModeBtn.addEventListener('click', onToggleEditMode);

    // Filter sliders -- live drag updates the CSS filter on `#image`.
    (Object.keys(dom.sliders) as Array<keyof FilterValues>).forEach((channel) => {
        dom.sliders[channel].addEventListener('input', (e) => {
            const raw = parseInt((e.target as HTMLInputElement).value, 10);
            filterValues = { ...filterValues, [channel]: clampFilterValue(channel, raw) };
            renderFilters();
        });
    });

    // Preset buttons -- click sets all four sliders to the preset's table.
    (Object.keys(dom.presetBtns) as FilterPresetName[]).forEach((name) => {
        dom.presetBtns[name].addEventListener('click', () => {
            filterValues = applyPreset(name);
            syncSlidersFromValues();
            renderFilters();
        });
    });

    // --- save flow (issue #15) -------------------------------------------
    // The Save button + Ctrl/Cmd+S keyboard shortcut both open a tiny
    // filename modal. On confirm, we composite the original image + the
    // current CSS filter + the edit-mode elements onto a `<canvas>`, encode
    // it as PNG, and hand the blob to `showSaveFilePicker` (preferred) or
    // an `<a download>` fallback.
    const openSaveModal = (): void => {
        // Don't open until the image actually loaded (no naturalWidth means
        // we'd composite a blank canvas).
        if (!dom.image.naturalWidth || !dom.image.naturalHeight) {
            return;
        }
        dom.filenameInput.value = defaultEditedFilename(file.name);
        dom.filenameModal.style.display = 'flex';
        // Defer focus so the input is interactive after the display flip.
        setTimeout(() => {
            dom.filenameInput.focus();
            dom.filenameInput.select();
        }, 0);
    };
    const closeSaveModal = (): void => {
        dom.filenameModal.style.display = 'none';
    };
    const performSave = async (): Promise<void> => {
        const filename = dom.filenameInput.value.trim() || defaultEditedFilename(file.name);
        closeSaveModal();
        const editCanvasRect = editMode.editCanvas.getBoundingClientRect();
        const composed = composeEditedImage({
            image: dom.image,
            editCanvasWidth: editCanvasRect.width || dom.image.naturalWidth,
            editCanvasHeight: editCanvasRect.height || dom.image.naturalHeight,
            filterString: buildFilterString(filterValues),
            elements: editMode.elementManager.list()
        });
        const blob = await canvasToBlob(composed, 'image/png');
        if (!blob) {
            // jsdom returns null; live browsers shouldn't hit this. Avoid
            // the alert in test environments (best-effort console log).
            console.warn('image viewer: composite blob encoding failed');
            return;
        }
        try {
            await saveBlob(blob, filename);
        } catch (err) {
            console.warn('image viewer: save failed', err);
        }
    };
    dom.saveBtn.addEventListener('click', openSaveModal);
    dom.filenameModalCancel.addEventListener('click', closeSaveModal);
    dom.filenameModalConfirm.addEventListener('click', () => {
        // Fire-and-forget — performSave handles its own errors.
        void performSave();
    });
    dom.filenameModal.addEventListener('click', (e) => {
        if (e.target === dom.filenameModal) {
            closeSaveModal();
        }
    });
    // Per-modal Enter / Escape so they work even though the modal input is
    // an <input> (which short-circuits the global keydown handler).
    dom.filenameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void performSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeSaveModal();
        }
    });

    // Keyboard shortcuts. Mirrors the VSCode original:
    //   - "R" / "r" is wired to reset (DoD explicitly lists "R reset").
    //   - "0" is wired to fit (DoD explicitly lists "0 fit").
    //   - Ctrl/Cmd+S opens the save modal (issue #15).
    const onKeyDown = (e: KeyboardEvent): void => {
        // Ctrl/Cmd+S handled first so we can still preventDefault when the
        // focus is in the filename input (otherwise the browser's
        // "save page" dialog steals it). The input has its own Enter handler,
        // so re-pressing Ctrl+S inside the modal is a no-op via early return.
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            const target = e.target as HTMLElement | null;
            // If the modal is already open, ignore — let the user finish typing.
            if (dom.filenameModal.style.display === 'flex') return;
            // If they're typing in some other input, also ignore.
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            openSaveModal();
            return;
        }
        // Ignore when the user is typing in an input/textarea, so the
        // shortcuts don't fight modal flows added by later issues.
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        switch (e.key) {
            case '+':
            case '=':
                e.preventDefault();
                onZoomIn();
                break;
            case '-':
            case '_':
                e.preventDefault();
                onZoomOut();
                break;
            case '0':
                e.preventDefault();
                onFit();
                break;
            case 'r':
            case 'R':
                e.preventDefault();
                onReset();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                transform = rotate(transform, -90);
                renderTransform();
                break;
            case 'ArrowRight':
                e.preventDefault();
                transform = rotate(transform, 90);
                renderTransform();
                break;
            default:
                break;
        }
    };
    document.addEventListener('keydown', onKeyDown);

    // --- image load -------------------------------------------------------
    dom.image.onload = () => {
        dom.loading.style.display = 'none';
        // Issue #9 step 5: switch #imageWrapper to display: block on load.
        dom.imageWrapper.style.display = 'block';
        dom.fileInfo.style.display = 'flex';
        updateInfo();
        fitToScreen();
        renderFilters();
    };
    dom.image.onerror = () => {
        dom.loading.style.display = 'none';
        dom.error.style.display = 'block';
        dom.error.textContent = 'Error loading image file';
    };
    dom.image.src = blobUrl;

    return {
        dispose(): void {
            document.removeEventListener('keydown', onKeyDown);
            editMode.dispose();
            try {
                URL.revokeObjectURL(blobUrl);
            } catch {
                // best-effort
            }
        }
    };
}

/**
 * Throws when a required DOM node is missing — that would only happen if
 * the HTML template above drifts out of sync, so a hard error is the right
 * failure mode (the caller renders the unsupported fallback).
 */
function resolveDom(container: HTMLElement): ImageViewerDom {
    const need = <T extends HTMLElement>(id: string): T => {
        const el = container.querySelector<T>(`#${id}`);
        if (!el) {
            throw new Error(`image viewer: missing DOM node #${id}`);
        }
        return el;
    };
    const root = container.querySelector<HTMLElement>('[data-image-viewer-root]');
    if (!root) {
        throw new Error('image viewer: failed to mount root element');
    }
    const imageContainer = root.querySelector<HTMLElement>('.iv-image-container');
    if (!imageContainer) {
        throw new Error('image viewer: missing .iv-image-container');
    }
    return {
        root,
        imageContainer,
        image: need<HTMLImageElement>('image'),
        imageWrapper: need('imageWrapper'),
        loading: need('loading'),
        error: need('error'),
        fileInfo: need('fileInfo'),
        sizeInfo: need('sizeInfo'),
        formatInfo: need('formatInfo'),
        fileSizeInfo: need('fileSizeInfo'),
        rotateBtn: need<HTMLButtonElement>('rotate'),
        flipHorizontalBtn: need<HTMLButtonElement>('flipHorizontal'),
        flipVerticalBtn: need<HTMLButtonElement>('flipVertical'),
        resetBtn: need<HTMLButtonElement>('reset'),
        fitToScreenBtn: need<HTMLButtonElement>('fitToScreen'),
        zoomOutBtn: need<HTMLButtonElement>('zoomOut'),
        zoomInBtn: need<HTMLButtonElement>('zoomIn'),
        presetBtns: {
            normal: need<HTMLButtonElement>('presetNormal'),
            bright: need<HTMLButtonElement>('presetBright'),
            dark: need<HTMLButtonElement>('presetDark'),
            vintage: need<HTMLButtonElement>('presetVintage'),
            bw: need<HTMLButtonElement>('presetBw')
        },
        sliders: {
            brightness: need<HTMLInputElement>('brightnessSlider'),
            contrast: need<HTMLInputElement>('contrastSlider'),
            saturation: need<HTMLInputElement>('saturationSlider'),
            grayscale: need<HTMLInputElement>('grayscaleSlider')
        },
        sliderValues: {
            brightness: need('brightnessValue'),
            contrast: need('contrastValue'),
            saturation: need('saturationValue'),
            grayscale: need('grayscaleValue')
        },
        toggleEditModeBtn: need<HTMLButtonElement>('toggleEditMode'),
        saveBtn: need<HTMLButtonElement>('saveImage'),
        editModeHost: need('editModeHost'),
        filenameModal: need('filenameModal'),
        filenameInput: need<HTMLInputElement>('filenameInput'),
        filenameModalConfirm: need<HTMLButtonElement>('confirmSave'),
        filenameModalCancel: need<HTMLButtonElement>('cancelSave')
    };
}
