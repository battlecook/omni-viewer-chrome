// Unit tests for the PDF text-annotation primitives (issue #19).
//
// Coverage:
//   - `pdfPointToScreenPx` / `screenPxToPdfPoint` are inverses across the
//     supported zoom range.
//   - `createPdfAnnotationStore` CRUD: add, list-by-page, update, remove,
//     clear, change-event emission.
//   - `createAnnotationIdFactory` produces unique ids.
//   - `buildTextAnnotationNode` projects PDF-point coordinates into the
//     correct overlay px offsets and applies size + color from the
//     annotation record.
//
// Coordinate model under test:
//   `screenX = annotation.x * scale; screenY = annotation.y * scale`
//   The overlay node is positioned at `(wrapper.offsetLeft + screenX,
//   wrapper.offsetTop + screenY)` so it stays glued to the page wrapper
//   regardless of where the user has scrolled.

import {
    createAnnotationIdFactory,
    createPdfAnnotationStore,
    PdfAnnotationChangeEvent,
    PdfTextAnnotation,
    pdfPointToScreenPx,
    screenPxToPdfPoint
} from '../templates/pdf/js/pdfAnnotationStore';
import {
    buildTextAnnotationNode,
    DEFAULT_TEXT_ANNOTATION_COLOR,
    DEFAULT_TEXT_ANNOTATION_SIZE
} from '../templates/pdf/js/annotations/text';

describe('pdfPointToScreenPx / screenPxToPdfPoint', () => {
    it('scales a PDF point into screen px at scale 1.0', () => {
        expect(pdfPointToScreenPx(100, 1)).toBe(100);
    });

    it('doubles a PDF point when scale is 2 (200%)', () => {
        expect(pdfPointToScreenPx(100, 2)).toBe(200);
    });

    it('halves a PDF point when scale is 0.5 (50%)', () => {
        expect(pdfPointToScreenPx(100, 0.5)).toBe(50);
    });

    it('round-trips through screenPxToPdfPoint at common zoom levels', () => {
        for (const percent of [50, 75, 100, 125, 150, 200, 300]) {
            const scale = percent / 100;
            const original = 137.42;
            const px = pdfPointToScreenPx(original, scale);
            expect(screenPxToPdfPoint(px, scale)).toBeCloseTo(original, 6);
        }
    });

    it('treats scale=0 as a no-op rather than dividing by zero', () => {
        expect(screenPxToPdfPoint(50, 0)).toBe(0);
    });
});

describe('createAnnotationIdFactory', () => {
    it('produces unique ids on consecutive calls', () => {
        const factory = createAnnotationIdFactory();
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            seen.add(factory('text'));
        }
        expect(seen.size).toBe(100);
    });

    it('encodes the kind in the id prefix', () => {
        const factory = createAnnotationIdFactory();
        expect(factory('text')).toMatch(/^text-/);
        expect(factory('signature')).toMatch(/^signature-/);
    });
});

describe('createPdfAnnotationStore', () => {
    it('returns the assigned id from addAnnotation', () => {
        let counter = 0;
        const store = createPdfAnnotationStore({
            idFactory: (kind) => `${kind}-${++counter}`
        });
        const id = store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 10,
            y: 20,
            text: 'hello',
            size: 16,
            color: '#ff0000'
        });
        expect(id).toBe('text-1');
    });

    it('lists annotations for the requested page only', () => {
        const store = createPdfAnnotationStore();
        store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 0,
            y: 0,
            text: 'page 0',
            size: 14,
            color: '#000'
        });
        store.addAnnotation({
            kind: 'text',
            pageIndex: 1,
            x: 0,
            y: 0,
            text: 'page 1',
            size: 14,
            color: '#000'
        });
        store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 5,
            y: 5,
            text: 'page 0 again',
            size: 14,
            color: '#000'
        });
        const page0 = store.listAnnotations(0);
        const page1 = store.listAnnotations(1);
        expect(page0).toHaveLength(2);
        expect(page1).toHaveLength(1);
        expect(page0.every((a) => a.pageIndex === 0)).toBe(true);
        expect(page1[0].pageIndex).toBe(1);
    });

    it('returns a snapshot copy (mutating it does not change the store)', () => {
        const store = createPdfAnnotationStore();
        const id = store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 1,
            y: 2,
            text: 'initial',
            size: 16,
            color: '#000'
        });
        const snapshot = store.listAnnotations(0)[0] as PdfTextAnnotation;
        snapshot.text = 'mutated';
        const fresh = store.getAnnotation(id) as PdfTextAnnotation;
        expect(fresh.text).toBe('initial');
    });

    it('removeAnnotation drops the record and returns true', () => {
        const store = createPdfAnnotationStore();
        const id = store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 0,
            y: 0,
            text: 'doomed',
            size: 12,
            color: '#000'
        });
        expect(store.removeAnnotation(id)).toBe(true);
        expect(store.listAnnotations(0)).toHaveLength(0);
        expect(store.removeAnnotation(id)).toBe(false);
    });

    it('updateAnnotation patches fields without changing kind', () => {
        const store = createPdfAnnotationStore();
        const id = store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 10,
            y: 10,
            text: 'old',
            size: 12,
            color: '#000'
        });
        const ok = store.updateAnnotation(id, {
            // Try to flip the kind — should be ignored.
            kind: 'signature',
            text: 'new',
            size: 24,
            color: '#ff0000'
        } as Partial<PdfTextAnnotation> & { kind?: 'signature' });
        expect(ok).toBe(true);
        const updated = store.getAnnotation(id) as PdfTextAnnotation;
        expect(updated.kind).toBe('text');
        expect(updated.text).toBe('new');
        expect(updated.size).toBe(24);
        expect(updated.color).toBe('#ff0000');
    });

    it('updateAnnotation returns false for unknown ids', () => {
        const store = createPdfAnnotationStore();
        expect(store.updateAnnotation('does-not-exist', { x: 0 })).toBe(false);
    });

    it('clear removes everything and emits a clear event', () => {
        const store = createPdfAnnotationStore();
        store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 0,
            y: 0,
            text: 'a',
            size: 12,
            color: '#000'
        });
        const events: PdfAnnotationChangeEvent[] = [];
        store.onChange((e) => events.push(e));
        store.clear();
        expect(store.listAll()).toHaveLength(0);
        expect(events).toEqual([{ type: 'clear' }]);
    });

    it('emits add / update / remove events with the affected id and pageIndex', () => {
        const store = createPdfAnnotationStore();
        const events: PdfAnnotationChangeEvent[] = [];
        store.onChange((e) => events.push(e));
        const id = store.addAnnotation({
            kind: 'text',
            pageIndex: 3,
            x: 0,
            y: 0,
            text: 'a',
            size: 12,
            color: '#000'
        });
        store.updateAnnotation(id, { text: 'b' });
        store.removeAnnotation(id);
        expect(events.map((e) => e.type)).toEqual(['add', 'update', 'remove']);
        expect(events.every((e) => e.id === id)).toBe(true);
        expect(events.every((e) => e.pageIndex === 3)).toBe(true);
    });

    it('onChange returns an unsubscribe function', () => {
        const store = createPdfAnnotationStore();
        const events: PdfAnnotationChangeEvent[] = [];
        const unsubscribe = store.onChange((e) => events.push(e));
        unsubscribe();
        store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 0,
            y: 0,
            text: 'a',
            size: 12,
            color: '#000'
        });
        expect(events).toHaveLength(0);
    });
});

describe('buildTextAnnotationNode', () => {
    let pagesContainer: HTMLElement;
    let wrapper: HTMLElement;

    beforeEach(() => {
        pagesContainer = document.createElement('div');
        wrapper = document.createElement('div');
        wrapper.className = 'pv-page-wrapper';
        wrapper.dataset.pageNumber = '1';
        pagesContainer.appendChild(wrapper);
        // jsdom doesn't lay out elements, so offsetLeft / offsetTop are 0
        // unless we patch them. Patching keeps the projection math
        // exercised end-to-end.
        Object.defineProperty(wrapper, 'offsetLeft', { value: 50, configurable: true });
        Object.defineProperty(wrapper, 'offsetTop', { value: 70, configurable: true });
    });

    const annotation = (overrides: Partial<PdfTextAnnotation> = {}): PdfTextAnnotation => ({
        id: 'text-1',
        kind: 'text',
        pageIndex: 0,
        x: 100,
        y: 200,
        text: 'hello',
        size: 16,
        color: '#ff0000',
        ...overrides
    });

    it('positions the node at wrapper.offset + (x*scale, y*scale)', () => {
        const node = buildTextAnnotationNode(annotation(), pagesContainer, 1)!;
        expect(node.style.left).toBe('150px'); // 50 + 100*1
        expect(node.style.top).toBe('270px');  // 70 + 200*1
    });

    it('honors a non-1.0 scale', () => {
        const node = buildTextAnnotationNode(annotation(), pagesContainer, 2)!;
        expect(node.style.left).toBe('250px'); // 50 + 100*2
        expect(node.style.top).toBe('470px');  // 70 + 200*2
    });

    it('scales font size by the same multiplier', () => {
        const node = buildTextAnnotationNode(annotation({ size: 16 }), pagesContainer, 2)!;
        expect(node.style.fontSize).toBe('32px'); // 16 * 2
    });

    it('applies the annotation color', () => {
        const node = buildTextAnnotationNode(
            annotation({ color: 'rgb(255, 0, 0)' }),
            pagesContainer,
            1
        )!;
        expect(node.style.color).toBe('rgb(255, 0, 0)');
    });

    it('writes the annotation text content verbatim', () => {
        const node = buildTextAnnotationNode(
            annotation({ text: 'multi\nline' }),
            pagesContainer,
            1
        )!;
        expect(node.textContent).toBe('multi\nline');
    });

    it('tags the node with annotation id and page number', () => {
        const node = buildTextAnnotationNode(
            annotation({ id: 'text-42', pageIndex: 0 }),
            pagesContainer,
            1
        )!;
        expect(node.dataset.annotationId).toBe('text-42');
        expect(node.dataset.pageNumber).toBe('1');
        expect(node.classList.contains('pv-annotation-text')).toBe(true);
    });

    it('returns null when the page wrapper is missing', () => {
        const node = buildTextAnnotationNode(
            annotation({ pageIndex: 99 }),
            pagesContainer,
            1
        );
        expect(node).toBeNull();
    });
});

describe('default text annotation constants', () => {
    it('exposes a positive default size in PDF points', () => {
        expect(DEFAULT_TEXT_ANNOTATION_SIZE).toBeGreaterThan(0);
    });

    it('exposes a CSS color string for the default color', () => {
        expect(DEFAULT_TEXT_ANNOTATION_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
    });
});
