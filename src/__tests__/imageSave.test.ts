/**
 * Unit tests for issue #15 image save helpers.
 *
 * Covered:
 *   - `defaultEditedFilename` (basename + extension stripping, edge cases)
 *   - `mimeFromExtension` / `extensionFromMime` round-trips
 *   - `isKnownImageExtension`
 *   - `naturalScaleForCanvas` (degenerate input handling)
 *   - `computeNaturalCoords` (center-coordinate mapping + font-size scaling)
 *   - `drawElementOnCanvas` (correct ctx calls for text / circle / rect)
 *   - `composeEditedImage` orchestrates filter application + drawImage
 *   - `saveBlob` prefers showSaveFilePicker, falls back to anchor download,
 *      and reports cancel cleanly
 */

import {
    defaultEditedFilename,
    mimeFromExtension,
    extensionFromMime,
    isKnownImageExtension,
    naturalScaleForCanvas,
    computeNaturalCoords,
    drawElementOnCanvas,
    composeEditedImage,
    canvasToBlob,
    saveBlob
} from '../templates/image/js/imageSave';
import type { ElementData } from '../templates/image/js/ImageEditMode/managers/ElementManager';

describe('defaultEditedFilename', () => {
    it('strips the trailing extension and appends -edited.png', () => {
        expect(defaultEditedFilename('photo.jpg')).toBe('photo-edited.png');
        expect(defaultEditedFilename('IMG_0001.PNG')).toBe('IMG_0001-edited.png');
    });

    it('only strips the LAST extension', () => {
        expect(defaultEditedFilename('archive.tar.gz')).toBe('archive.tar-edited.png');
    });

    it('handles names without an extension', () => {
        expect(defaultEditedFilename('Makefile')).toBe('Makefile-edited.png');
    });

    it('handles dotfiles (leading dot, no extension)', () => {
        // ".gitignore" -> stem becomes "" because lastDot === 0; we treat it
        // as no-stem and fall back to the generic name.
        expect(defaultEditedFilename('.gitignore')).toBe('.gitignore-edited.png');
    });

    it('falls back for empty / non-string input', () => {
        expect(defaultEditedFilename('')).toBe('image-edited.png');
        expect(defaultEditedFilename('   ')).toBe('image-edited.png');
        expect(defaultEditedFilename(undefined as unknown as string)).toBe('image-edited.png');
        expect(defaultEditedFilename(null as unknown as string)).toBe('image-edited.png');
    });

    it('strips a path prefix', () => {
        expect(defaultEditedFilename('/Users/x/photo.png')).toBe('photo-edited.png');
        expect(defaultEditedFilename('C:\\Users\\x\\photo.png')).toBe('photo-edited.png');
    });
});

describe('mimeFromExtension / extensionFromMime', () => {
    it('maps known extensions to canonical MIME', () => {
        expect(mimeFromExtension('foo.png')).toBe('image/png');
        expect(mimeFromExtension('FOO.JPG')).toBe('image/jpeg');
        expect(mimeFromExtension('foo.jpeg')).toBe('image/jpeg');
        expect(mimeFromExtension('foo.webp')).toBe('image/webp');
        expect(mimeFromExtension('foo.gif')).toBe('image/gif');
        expect(mimeFromExtension('foo.bmp')).toBe('image/bmp');
    });

    it('falls back to image/png for unknown / missing extensions', () => {
        expect(mimeFromExtension('foo')).toBe('image/png');
        expect(mimeFromExtension('foo.')).toBe('image/png');
        expect(mimeFromExtension('foo.tiff')).toBe('image/png');
        expect(mimeFromExtension('')).toBe('image/png');
        expect(mimeFromExtension(undefined as unknown as string)).toBe('image/png');
    });

    it('extensionFromMime is the inverse of the canonical map', () => {
        expect(extensionFromMime('image/png')).toBe('png');
        expect(extensionFromMime('image/jpeg')).toBe('jpg');
        expect(extensionFromMime('image/webp')).toBe('webp');
        expect(extensionFromMime('IMAGE/PNG')).toBe('png'); // case insensitive
        expect(extensionFromMime('application/octet-stream')).toBe('png');
    });

    it('isKnownImageExtension recognises raster image extensions', () => {
        expect(isKnownImageExtension('foo.png')).toBe(true);
        expect(isKnownImageExtension('foo.JPG')).toBe(true);
        expect(isKnownImageExtension('foo.txt')).toBe(false);
        expect(isKnownImageExtension('foo')).toBe(false);
        expect(isKnownImageExtension('foo.')).toBe(false);
    });
});

describe('naturalScaleForCanvas', () => {
    it('returns identity scale when canvas matches natural size', () => {
        expect(naturalScaleForCanvas(800, 600, 800, 600)).toEqual({ sx: 1, sy: 1 });
    });

    it('scales up when the displayed canvas is smaller than the image', () => {
        // Image is 1600x1200, canvas is 800x600 -> scale 2x on each axis.
        expect(naturalScaleForCanvas(800, 600, 1600, 1200)).toEqual({ sx: 2, sy: 2 });
    });

    it('handles non-uniform scale factors per axis', () => {
        // Image is 800x900, canvas is 400x300 -> sx = 2, sy = 3
        expect(naturalScaleForCanvas(400, 300, 800, 900)).toEqual({ sx: 2, sy: 3 });
    });

    it('is defensive against zero / negative inputs', () => {
        expect(naturalScaleForCanvas(0, 0, 100, 100)).toEqual({ sx: 1, sy: 1 });
        expect(naturalScaleForCanvas(100, 100, 0, 0)).toEqual({ sx: 1, sy: 1 });
        expect(naturalScaleForCanvas(-5, -5, 100, 100)).toEqual({ sx: 1, sy: 1 });
    });
});

describe('computeNaturalCoords', () => {
    const baseRect: ElementData = {
        id: 'el-1',
        type: 'rect',
        x: 100,
        y: 50,
        w: 40,
        h: 20,
        style: { fill: '#ff0000', stroke: '#000000', strokeWidth: 2, opacity: 1 }
    };

    it('maps canvas-local center / size to natural-image px', () => {
        const coords = computeNaturalCoords(baseRect, { sx: 2, sy: 3 });
        expect(coords.cx).toBe(200);
        expect(coords.cy).toBe(150);
        expect(coords.w).toBe(80);
        expect(coords.h).toBe(60);
        expect(coords.fontSize).toBe(0); // shapes carry no font size
    });

    it('scales font size by the larger axis for text', () => {
        const text: ElementData = {
            id: 'el-2',
            type: 'text',
            x: 0,
            y: 0,
            w: 60,
            h: 30,
            text: 'hi',
            style: { fill: '#000', fontSize: 20, opacity: 1 }
        };
        const coords = computeNaturalCoords(text, { sx: 2, sy: 1 });
        expect(coords.fontSize).toBe(40);
    });

    it('defaults to 24 px font size when style.fontSize is missing', () => {
        const text: ElementData = {
            id: 'el-3',
            type: 'text',
            x: 0,
            y: 0,
            w: 60,
            h: 30,
            text: 'hi',
            style: {}
        };
        const coords = computeNaturalCoords(text, { sx: 1, sy: 1 });
        expect(coords.fontSize).toBe(24);
    });

    it('clamps negative width / height to 0', () => {
        const c = computeNaturalCoords(
            { ...baseRect, w: -10, h: -10 },
            { sx: 1, sy: 1 }
        );
        expect(c.w).toBe(0);
        expect(c.h).toBe(0);
    });
});

// --- drawElementOnCanvas ----------------------------------------------

interface FakeCtxCalls {
    saved: number;
    restored: number;
    fillRectCalls: Array<[number, number, number, number]>;
    strokeRectCalls: Array<[number, number, number, number]>;
    fillTextCalls: Array<[string, number, number]>;
    arcCalls: Array<[number, number, number, number, number]>;
    fillCalls: number;
    strokeCalls: number;
    fillStyles: string[];
    strokeStyles: string[];
    lineWidths: number[];
    fonts: string[];
    textAlignSet: string[];
    textBaselineSet: string[];
    globalAlphas: number[];
    beginPathCalls: number;
}

function createFakeCtx(): { ctx: CanvasRenderingContext2D; calls: FakeCtxCalls } {
    const calls: FakeCtxCalls = {
        saved: 0,
        restored: 0,
        fillRectCalls: [],
        strokeRectCalls: [],
        fillTextCalls: [],
        arcCalls: [],
        fillCalls: 0,
        strokeCalls: 0,
        fillStyles: [],
        strokeStyles: [],
        lineWidths: [],
        fonts: [],
        textAlignSet: [],
        textBaselineSet: [],
        globalAlphas: [],
        beginPathCalls: 0
    };
    const ctx = {
        save() { calls.saved += 1; },
        restore() { calls.restored += 1; },
        fillRect(x: number, y: number, w: number, h: number) {
            calls.fillRectCalls.push([x, y, w, h]);
        },
        strokeRect(x: number, y: number, w: number, h: number) {
            calls.strokeRectCalls.push([x, y, w, h]);
        },
        fillText(text: string, x: number, y: number) {
            calls.fillTextCalls.push([text, x, y]);
        },
        beginPath() { calls.beginPathCalls += 1; },
        arc(cx: number, cy: number, r: number, s: number, e: number) {
            calls.arcCalls.push([cx, cy, r, s, e]);
        },
        fill() { calls.fillCalls += 1; },
        stroke() { calls.strokeCalls += 1; },
        set fillStyle(v: string) { calls.fillStyles.push(v); },
        get fillStyle() { return calls.fillStyles[calls.fillStyles.length - 1] ?? ''; },
        set strokeStyle(v: string) { calls.strokeStyles.push(v); },
        get strokeStyle() { return calls.strokeStyles[calls.strokeStyles.length - 1] ?? ''; },
        set lineWidth(v: number) { calls.lineWidths.push(v); },
        get lineWidth() { return calls.lineWidths[calls.lineWidths.length - 1] ?? 1; },
        set font(v: string) { calls.fonts.push(v); },
        get font() { return calls.fonts[calls.fonts.length - 1] ?? ''; },
        set textAlign(v: string) { calls.textAlignSet.push(v); },
        get textAlign() { return calls.textAlignSet[calls.textAlignSet.length - 1] ?? ''; },
        set textBaseline(v: string) { calls.textBaselineSet.push(v); },
        get textBaseline() { return calls.textBaselineSet[calls.textBaselineSet.length - 1] ?? ''; },
        set globalAlpha(v: number) { calls.globalAlphas.push(v); },
        get globalAlpha() { return calls.globalAlphas[calls.globalAlphas.length - 1] ?? 1; }
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
}

describe('drawElementOnCanvas', () => {
    const scale = { sx: 1, sy: 1 };

    it('renders text centered on (cx, cy) with the right font + alignment', () => {
        const text: ElementData = {
            id: 'el-1',
            type: 'text',
            x: 100,
            y: 50,
            w: 40,
            h: 20,
            text: 'Hello',
            style: { fill: '#112233', fontSize: 24, opacity: 0.8 }
        };
        const { ctx, calls } = createFakeCtx();
        drawElementOnCanvas(ctx, text, scale);
        expect(calls.saved).toBe(1);
        expect(calls.restored).toBe(1);
        expect(calls.globalAlphas).toContain(0.8);
        expect(calls.fillStyles).toContain('#112233');
        expect(calls.fonts.some((f) => f.startsWith('24px '))).toBe(true);
        expect(calls.textAlignSet).toContain('center');
        expect(calls.textBaselineSet).toContain('middle');
        expect(calls.fillTextCalls).toEqual([['Hello', 100, 50]]);
    });

    it('renders rect with fill + stroke, top-left derived from center', () => {
        const rect: ElementData = {
            id: 'el-2',
            type: 'rect',
            x: 100,
            y: 100,
            w: 40,
            h: 20,
            style: { fill: '#ff0000', stroke: '#00ff00', strokeWidth: 4, opacity: 1 }
        };
        const { ctx, calls } = createFakeCtx();
        drawElementOnCanvas(ctx, rect, scale);
        // Top-left = (100 - 20, 100 - 10) = (80, 90)
        expect(calls.fillRectCalls).toEqual([[80, 90, 40, 20]]);
        expect(calls.strokeRectCalls).toEqual([[80, 90, 40, 20]]);
        expect(calls.fillStyles).toContain('#ff0000');
        expect(calls.strokeStyles).toContain('#00ff00');
        expect(calls.lineWidths).toContain(4);
    });

    it('renders circle with arc + radius respecting stroke-half offset', () => {
        const circle: ElementData = {
            id: 'el-3',
            type: 'circle',
            x: 50,
            y: 50,
            w: 40,
            h: 40,
            style: { fill: '#abcdef', stroke: '#000000', strokeWidth: 4, opacity: 1 }
        };
        const { ctx, calls } = createFakeCtx();
        drawElementOnCanvas(ctx, circle, scale);
        // r = min(40,40)/2 - 4/2 = 20 - 2 = 18
        expect(calls.arcCalls).toEqual([[50, 50, 18, 0, Math.PI * 2]]);
        expect(calls.fillCalls).toBe(1);
        expect(calls.strokeCalls).toBe(1);
        expect(calls.beginPathCalls).toBe(1);
    });

    it('honors element opacity via globalAlpha', () => {
        const rect: ElementData = {
            id: 'el-4',
            type: 'rect',
            x: 0, y: 0, w: 10, h: 10,
            style: { fill: '#fff', stroke: '#000', strokeWidth: 0, opacity: 0.25 }
        };
        const { ctx, calls } = createFakeCtx();
        drawElementOnCanvas(ctx, rect, scale);
        expect(calls.globalAlphas).toContain(0.25);
    });

    it('skips stroke when strokeWidth scales to 0', () => {
        const rect: ElementData = {
            id: 'el-5',
            type: 'rect',
            x: 10, y: 10, w: 20, h: 20,
            style: { fill: '#fff', stroke: '#000', strokeWidth: 0, opacity: 1 }
        };
        const { ctx, calls } = createFakeCtx();
        drawElementOnCanvas(ctx, rect, { sx: 1, sy: 1 });
        expect(calls.fillRectCalls.length).toBe(1);
        expect(calls.strokeRectCalls.length).toBe(0);
    });
});

// --- composeEditedImage -----------------------------------------------

describe('composeEditedImage', () => {
    function makeImage(naturalW: number, naturalH: number): HTMLImageElement {
        const img = document.createElement('img');
        Object.defineProperty(img, 'naturalWidth', { value: naturalW, configurable: true });
        Object.defineProperty(img, 'naturalHeight', { value: naturalH, configurable: true });
        return img;
    }

    it('returns a canvas sized to the image natural dimensions', () => {
        const canvas = composeEditedImage({
            image: makeImage(640, 480),
            editCanvasWidth: 320,
            editCanvasHeight: 240,
            filterString: 'brightness(100%)',
            elements: []
        });
        expect(canvas.width).toBe(640);
        expect(canvas.height).toBe(480);
    });

    it('drawImage is called with natural width/height', () => {
        const drawImageSpy = jest.fn();
        const filterValues: string[] = [];
        // Spy on getContext to substitute a recording context.
        const real = HTMLCanvasElement.prototype.getContext;
        const ctxStub = {
            set filter(v: string) { filterValues.push(v); },
            get filter() { return filterValues[filterValues.length - 1] ?? 'none'; },
            drawImage: drawImageSpy,
            save() {}, restore() {},
            fillRect() {}, strokeRect() {}, fillText() {},
            beginPath() {}, arc() {}, fill() {}, stroke() {},
            set fillStyle(_v: string) {}, get fillStyle() { return ''; },
            set strokeStyle(_v: string) {}, get strokeStyle() { return ''; },
            set lineWidth(_v: number) {}, get lineWidth() { return 1; },
            set font(_v: string) {}, get font() { return ''; },
            set textAlign(_v: string) {}, get textAlign() { return ''; },
            set textBaseline(_v: string) {}, get textBaseline() { return ''; },
            set globalAlpha(_v: number) {}, get globalAlpha() { return 1; }
        } as unknown as CanvasRenderingContext2D;
        HTMLCanvasElement.prototype.getContext = function () { return ctxStub; } as never;

        try {
            composeEditedImage({
                image: makeImage(800, 600),
                editCanvasWidth: 400,
                editCanvasHeight: 300,
                filterString: 'brightness(120%) contrast(110%) saturate(100%) grayscale(0%)',
                elements: []
            });
            // First arg is the image; positional check: w = 800, h = 600.
            expect(drawImageSpy).toHaveBeenCalledTimes(1);
            const args = drawImageSpy.mock.calls[0];
            expect(args[1]).toBe(0);
            expect(args[2]).toBe(0);
            expect(args[3]).toBe(800);
            expect(args[4]).toBe(600);
            // Filter was set to the supplied filter string at least once,
            // then reset to 'none' before drawing elements.
            expect(filterValues).toContain('brightness(120%) contrast(110%) saturate(100%) grayscale(0%)');
            expect(filterValues).toContain('none');
        } finally {
            HTMLCanvasElement.prototype.getContext = real;
        }
    });
});

// --- canvasToBlob -----------------------------------------------------

describe('canvasToBlob', () => {
    it('resolves to null when toBlob fires its callback with null (jsdom default)', async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 10;
        canvas.height = 10;
        // jsdom's toBlob is missing or returns null. Force-mock it for determinism.
        (canvas.toBlob as unknown as jest.Mock) = jest.fn((cb: BlobCallback) => cb(null));
        const blob = await canvasToBlob(canvas);
        expect(blob).toBeNull();
    });

    it('resolves with the blob when toBlob succeeds', async () => {
        const canvas = document.createElement('canvas');
        const expected = new Blob(['x'], { type: 'image/png' });
        (canvas.toBlob as unknown as jest.Mock) = jest.fn((cb: BlobCallback) => cb(expected));
        const blob = await canvasToBlob(canvas);
        expect(blob).toBe(expected);
    });
});

// --- saveBlob ---------------------------------------------------------

describe('saveBlob', () => {
    afterEach(() => {
        // Drop the stub between tests.
        delete (globalThis as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });

    it('uses showSaveFilePicker when available and returns "saved"', async () => {
        const writeMock = jest.fn().mockResolvedValue(undefined);
        const closeMock = jest.fn().mockResolvedValue(undefined);
        const createWritableMock = jest.fn().mockResolvedValue({ write: writeMock, close: closeMock });
        const pickerMock = jest.fn().mockResolvedValue({ createWritable: createWritableMock });
        (globalThis as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = pickerMock;

        const blob = new Blob(['hello'], { type: 'image/png' });
        const result = await saveBlob(blob, 'foo.png');
        expect(result).toBe('saved');
        expect(pickerMock).toHaveBeenCalledTimes(1);
        const opts = pickerMock.mock.calls[0][0];
        expect(opts.suggestedName).toBe('foo.png');
        expect(opts.types[0].accept['image/png']).toEqual(['.png']);
        expect(writeMock).toHaveBeenCalledWith(blob);
        expect(closeMock).toHaveBeenCalled();
    });

    it('returns "cancelled" when the user aborts the picker', async () => {
        const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
        (globalThis as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = jest.fn().mockRejectedValue(abortErr);

        const result = await saveBlob(new Blob(['hi']), 'foo.png');
        expect(result).toBe('cancelled');
    });

    it('falls back to anchor download when picker throws non-abort errors', async () => {
        (globalThis as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = jest.fn().mockRejectedValue(new Error('nope'));

        // Stub URL.createObjectURL/revokeObjectURL — jsdom has them but URL.revoke is fine.
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:fake');
        URL.revokeObjectURL = jest.fn();

        const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        try {
            const result = await saveBlob(new Blob(['hi']), 'foo.png');
            expect(result).toBe('downloaded');
            expect(clickSpy).toHaveBeenCalledTimes(1);
            expect(URL.createObjectURL).toHaveBeenCalled();
        } finally {
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
            clickSpy.mockRestore();
        }
    });

    it('falls back to anchor download when picker is not available', async () => {
        // No picker installed.
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:fake');
        URL.revokeObjectURL = jest.fn();
        const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        try {
            const result = await saveBlob(new Blob(['hi']), 'bar.png');
            expect(result).toBe('downloaded');
            expect(clickSpy).toHaveBeenCalledTimes(1);
        } finally {
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
            clickSpy.mockRestore();
        }
    });

    it('skips the picker entirely when preferPicker = false', async () => {
        const pickerMock = jest.fn();
        (globalThis as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = pickerMock;
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:fake');
        URL.revokeObjectURL = jest.fn();
        const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        try {
            const result = await saveBlob(new Blob(['hi']), 'foo.png', { preferPicker: false });
            expect(result).toBe('downloaded');
            expect(pickerMock).not.toHaveBeenCalled();
        } finally {
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
            clickSpy.mockRestore();
        }
    });
});
