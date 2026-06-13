// Unit tests for the PDF signature-annotation primitives (issue #20).
//
// Coverage:
//   - Pure pen-pad helpers: `addPoint`, `boundingBox`, `simplifyStroke`,
//     `paintStroke`, `distanceSquared`.
//   - Annotation-store integration: `signature` kind round-trips through
//     `createPdfAnnotationStore` (add / list-by-page / list-all / update
//     guards `kind` / remove / clear).
//   - DOM rendering: `buildSignatureAnnotationNode` projects PDF-point
//     coordinates into the correct overlay px offsets and applies width,
//     height and `dataUrl` from the annotation record.
//   - Mode handle: `attachSignatureAnnotationMode` toggles a CSS class
//     on the container and projects pointer events into PDF point space
//     via the supplied `getScale` callback.
//
// Coordinate model under test (locked by issue #19):
//   `screenX = annotation.x * scale; screenY = annotation.y * scale`
//   The overlay node is positioned at `(wrapper.offsetLeft + screenX,
//   wrapper.offsetTop + screenY)` so the signature stays glued to its
//   page wrapper across scrolling.

import {
    SignaturePainter,
    SignaturePoint,
    addPoint,
    boundingBox,
    distanceSquared,
    paintStroke,
    simplifyStroke,
    DEFAULT_MIN_POINT_DISTANCE
} from '../templates/pdf/js/signaturePad';
import {
    createPdfAnnotationStore,
    PdfSignatureAnnotation
} from '../templates/pdf/js/pdfAnnotationStore';
import {
    DEFAULT_SIGNATURE_COLOR,
    DEFAULT_SIGNATURE_HEIGHT,
    DEFAULT_SIGNATURE_WIDTH,
    attachSignatureAnnotationMode,
    buildSignatureAnnotationNode
} from '../templates/pdf/js/annotations/signature';

describe('signaturePad: addPoint', () => {
    it('returns the midpoint as the segment endpoint and the prev sample as the control', () => {
        const segment = addPoint({ x: 0, y: 0 }, { x: 10, y: 20 });
        expect(segment).toEqual({
            controlX: 0,
            controlY: 0,
            endX: 5,
            endY: 10
        });
    });

    it('handles negative coordinates symmetrically', () => {
        const segment = addPoint({ x: -4, y: -6 }, { x: 4, y: 6 });
        expect(segment.controlX).toBe(-4);
        expect(segment.controlY).toBe(-6);
        expect(segment.endX).toBe(0);
        expect(segment.endY).toBe(0);
    });

    it('returns a degenerate segment for coincident samples', () => {
        const segment = addPoint({ x: 7, y: 9 }, { x: 7, y: 9 });
        expect(segment.endX).toBe(7);
        expect(segment.endY).toBe(9);
        expect(segment.controlX).toBe(7);
        expect(segment.controlY).toBe(9);
    });
});

describe('signaturePad: boundingBox', () => {
    it('returns a zero-sized rect at origin for an empty list', () => {
        expect(boundingBox([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it('collapses a single sample to a 0x0 rect at the sample position', () => {
        expect(boundingBox([{ x: 13, y: 27 }])).toEqual({
            x: 13,
            y: 27,
            width: 0,
            height: 0
        });
    });

    it('returns the axis-aligned bounding box of multiple samples', () => {
        const points: SignaturePoint[] = [
            { x: 5, y: 10 },
            { x: 30, y: 4 },
            { x: 12, y: 50 },
            { x: 0, y: 22 }
        ];
        expect(boundingBox(points)).toEqual({
            x: 0,
            y: 4,
            width: 30,
            height: 46
        });
    });
});

describe('signaturePad: distanceSquared', () => {
    it('is zero for the same point', () => {
        expect(distanceSquared({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
    });

    it('matches the squared Pythagorean distance', () => {
        expect(distanceSquared({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(25);
    });
});

describe('signaturePad: simplifyStroke', () => {
    it('returns an empty list for empty input', () => {
        expect(simplifyStroke([])).toEqual([]);
    });

    it('returns a clone of a single-sample input', () => {
        const input: SignaturePoint[] = [{ x: 1, y: 2 }];
        const out = simplifyStroke(input);
        expect(out).toEqual([{ x: 1, y: 2 }]);
        expect(out[0]).not.toBe(input[0]);
    });

    it('drops samples within minDistance of the previously kept sample', () => {
        const points: SignaturePoint[] = [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 }, // within default threshold
            { x: 10, y: 10 },
            { x: 10.4, y: 10.0 }, // within default threshold of {10,10}
            { x: 30, y: 30 }
        ];
        const out = simplifyStroke(points);
        expect(out).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 10 },
            { x: 30, y: 30 }
        ]);
    });

    it('always keeps the final sample even when within the threshold', () => {
        const points: SignaturePoint[] = [
            { x: 0, y: 0 },
            { x: 0.1, y: 0.1 } // below threshold but it's the final sample
        ];
        const out = simplifyStroke(points);
        expect(out[0]).toEqual({ x: 0, y: 0 });
        expect(out[out.length - 1]).toEqual({ x: 0.1, y: 0.1 });
    });

    it('keeps every sample when minDistance is 0', () => {
        const points: SignaturePoint[] = [
            { x: 0, y: 0 },
            { x: 0.1, y: 0.1 },
            { x: 0.2, y: 0.2 }
        ];
        const out = simplifyStroke(points, 0);
        expect(out).toHaveLength(3);
    });

    it('exposes a sane default threshold', () => {
        expect(DEFAULT_MIN_POINT_DISTANCE).toBeGreaterThan(0);
    });
});

describe('signaturePad: paintStroke', () => {
    interface PainterCall {
        op: 'moveTo' | 'lineTo' | 'quadraticCurveTo';
        args: number[];
    }

    const recordPainter = (): SignaturePainter & { calls: PainterCall[] } => {
        const calls: PainterCall[] = [];
        return {
            calls,
            moveTo(x, y) {
                calls.push({ op: 'moveTo', args: [x, y] });
            },
            lineTo(x, y) {
                calls.push({ op: 'lineTo', args: [x, y] });
            },
            quadraticCurveTo(cx, cy, x, y) {
                calls.push({ op: 'quadraticCurveTo', args: [cx, cy, x, y] });
            }
        };
    };

    it('does nothing for an empty stroke', () => {
        const painter = recordPainter();
        paintStroke([], painter);
        expect(painter.calls).toEqual([]);
    });

    it('renders a single-sample stroke as a 0-length line at that sample', () => {
        const painter = recordPainter();
        paintStroke([{ x: 5, y: 7 }], painter);
        expect(painter.calls).toEqual([
            { op: 'moveTo', args: [5, 7] },
            { op: 'lineTo', args: [5, 7] }
        ]);
    });

    it('paints quadratic curves for every interior segment', () => {
        const painter = recordPainter();
        const points: SignaturePoint[] = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 }
        ];
        paintStroke(points, painter);
        // moveTo(start), quadTo(control=prev, end=mid)*2, lineTo(last)
        expect(painter.calls[0]).toEqual({ op: 'moveTo', args: [0, 0] });
        expect(painter.calls[1].op).toBe('quadraticCurveTo');
        expect(painter.calls[1].args).toEqual([0, 0, 5, 0]);
        expect(painter.calls[2].op).toBe('quadraticCurveTo');
        expect(painter.calls[2].args).toEqual([10, 0, 10, 5]);
        expect(painter.calls[3]).toEqual({ op: 'lineTo', args: [10, 10] });
    });
});

describe('annotation store: signature kind', () => {
    it('round-trips a signature annotation through add / get', () => {
        let counter = 0;
        const store = createPdfAnnotationStore({
            idFactory: (kind) => `${kind}-${++counter}`
        });
        const id = store.addAnnotation({
            kind: 'signature',
            pageIndex: 2,
            x: 50,
            y: 80,
            dataUrl: 'data:image/png;base64,AAA=',
            width: 120,
            height: 60
        });
        expect(id).toBe('signature-1');
        const fetched = store.getAnnotation(id) as PdfSignatureAnnotation;
        expect(fetched.kind).toBe('signature');
        expect(fetched.pageIndex).toBe(2);
        expect(fetched.dataUrl).toBe('data:image/png;base64,AAA=');
        expect(fetched.width).toBe(120);
        expect(fetched.height).toBe(60);
    });

    it('lists signature annotations alongside text annotations on the same page', () => {
        const store = createPdfAnnotationStore();
        store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 10,
            y: 20,
            text: 'hi',
            size: 14,
            color: '#000'
        });
        store.addAnnotation({
            kind: 'signature',
            pageIndex: 0,
            x: 50,
            y: 80,
            dataUrl: 'data:image/png;base64,AAA=',
            width: 120,
            height: 60
        });
        store.addAnnotation({
            kind: 'signature',
            pageIndex: 1,
            x: 10,
            y: 10,
            dataUrl: 'data:image/png;base64,BBB=',
            width: 100,
            height: 40
        });
        const page0 = store.listAnnotations(0);
        expect(page0).toHaveLength(2);
        const kinds = page0.map((a) => a.kind).sort();
        expect(kinds).toEqual(['signature', 'text']);
        const page1 = store.listAnnotations(1);
        expect(page1).toHaveLength(1);
        expect(page1[0].kind).toBe('signature');
    });

    it('supports multiple signatures (DoD)', () => {
        const store = createPdfAnnotationStore();
        for (let i = 0; i < 5; i++) {
            store.addAnnotation({
                kind: 'signature',
                pageIndex: 0,
                x: i * 20,
                y: i * 30,
                dataUrl: `data:image/png;base64,${i}`,
                width: 120,
                height: 60
            });
        }
        const all = store.listAll().filter((a) => a.kind === 'signature');
        expect(all).toHaveLength(5);
        const ids = new Set(all.map((a) => a.id));
        expect(ids.size).toBe(5);
    });

    it('updateAnnotation cannot turn a signature into a text annotation', () => {
        const store = createPdfAnnotationStore();
        const id = store.addAnnotation({
            kind: 'signature',
            pageIndex: 0,
            x: 0,
            y: 0,
            dataUrl: 'data:image/png;base64,AAA=',
            width: 100,
            height: 40
        });
        // Try to subvert the discriminator.
        const ok = store.updateAnnotation(id, {
            kind: 'text',
            width: 200
        } as Partial<PdfSignatureAnnotation> & { kind?: 'text' });
        expect(ok).toBe(true);
        const fetched = store.getAnnotation(id) as PdfSignatureAnnotation;
        expect(fetched.kind).toBe('signature');
        expect(fetched.width).toBe(200);
    });

    it('removes a signature annotation by id', () => {
        const store = createPdfAnnotationStore();
        const id = store.addAnnotation({
            kind: 'signature',
            pageIndex: 0,
            x: 0,
            y: 0,
            dataUrl: 'data:image/png;base64,AAA=',
            width: 100,
            height: 40
        });
        expect(store.removeAnnotation(id)).toBe(true);
        expect(store.listAll()).toHaveLength(0);
    });
});

describe('buildSignatureAnnotationNode', () => {
    let pagesContainer: HTMLElement;
    let wrapper: HTMLElement;

    beforeEach(() => {
        pagesContainer = document.createElement('div');
        wrapper = document.createElement('div');
        wrapper.className = 'pv-page-wrapper';
        wrapper.dataset.pageNumber = '1';
        pagesContainer.appendChild(wrapper);
        Object.defineProperty(wrapper, 'offsetLeft', { value: 50, configurable: true });
        Object.defineProperty(wrapper, 'offsetTop', { value: 70, configurable: true });
    });

    const annotation = (
        overrides: Partial<PdfSignatureAnnotation> = {}
    ): PdfSignatureAnnotation => ({
        id: 'signature-1',
        kind: 'signature',
        pageIndex: 0,
        x: 100,
        y: 200,
        dataUrl: 'data:image/png;base64,AAA=',
        width: 120,
        height: 60,
        ...overrides
    });

    it('positions the node at wrapper.offset + (x*scale, y*scale)', () => {
        const node = buildSignatureAnnotationNode(annotation(), pagesContainer, 1)!;
        expect(node).not.toBeNull();
        expect(node.style.left).toBe('150px'); // 50 + 100*1
        expect(node.style.top).toBe('270px');  // 70 + 200*1
    });

    it('honors a non-1.0 scale for both position and size', () => {
        const node = buildSignatureAnnotationNode(annotation(), pagesContainer, 2)!;
        expect(node.style.left).toBe('250px'); // 50 + 100*2
        expect(node.style.top).toBe('470px');  // 70 + 200*2
        expect(node.style.width).toBe('240px'); // 120*2
        expect(node.style.height).toBe('120px'); // 60*2
    });

    it('renders an <img> with the supplied data URL as src', () => {
        const node = buildSignatureAnnotationNode(annotation(), pagesContainer, 1)!;
        expect(node.tagName).toBe('IMG');
        expect((node as HTMLImageElement).src).toBe('data:image/png;base64,AAA=');
    });

    it('tags the node with annotation id, page number, and CSS class', () => {
        const node = buildSignatureAnnotationNode(
            annotation({ id: 'signature-42' }),
            pagesContainer,
            1
        )!;
        expect(node.dataset.annotationId).toBe('signature-42');
        expect(node.dataset.pageNumber).toBe('1');
        expect(node.classList.contains('pv-annotation-signature')).toBe(true);
    });

    it('returns null when the page wrapper is missing', () => {
        const node = buildSignatureAnnotationNode(
            annotation({ pageIndex: 99 }),
            pagesContainer,
            1
        );
        expect(node).toBeNull();
    });

    it('disables native image dragging so the signature does not start a drag-image', () => {
        const node = buildSignatureAnnotationNode(annotation(), pagesContainer, 1)!;
        expect((node as HTMLImageElement).draggable).toBe(false);
    });
});

describe('attachSignatureAnnotationMode', () => {
    let pagesContainer: HTMLElement;
    let wrapper: HTMLElement;

    beforeEach(() => {
        document.body.innerHTML = '';
        pagesContainer = document.createElement('div');
        wrapper = document.createElement('div');
        wrapper.className = 'pv-page-wrapper';
        wrapper.dataset.pageNumber = '3';
        pagesContainer.appendChild(wrapper);
        document.body.appendChild(pagesContainer);
        Object.defineProperty(wrapper, 'getBoundingClientRect', {
            configurable: true,
            value: () =>
                ({
                    left: 100,
                    top: 50,
                    right: 500,
                    bottom: 450,
                    width: 400,
                    height: 400,
                    x: 100,
                    y: 50,
                    toJSON() {
                        /* noop */
                    }
                }) as DOMRect
        });
    });

    it('starts disabled', () => {
        const handle = attachSignatureAnnotationMode({
            pagesContainer,
            getScale: () => 1,
            onClick: () => {
                /* noop */
            }
        });
        expect(handle.isActive()).toBe(false);
        expect(pagesContainer.classList.contains('pv-signature-mode')).toBe(false);
        handle.dispose();
    });

    it('toggles the CSS class on enable / disable', () => {
        const handle = attachSignatureAnnotationMode({
            pagesContainer,
            getScale: () => 1,
            onClick: () => {
                /* noop */
            }
        });
        handle.enable();
        expect(handle.isActive()).toBe(true);
        expect(pagesContainer.classList.contains('pv-signature-mode')).toBe(true);
        handle.disable();
        expect(handle.isActive()).toBe(false);
        expect(pagesContainer.classList.contains('pv-signature-mode')).toBe(false);
        handle.dispose();
    });

    it('projects pointer offsets into PDF point space using the supplied scale', () => {
        const events: Array<{ pageIndex: number; x: number; y: number }> = [];
        const handle = attachSignatureAnnotationMode({
            pagesContainer,
            getScale: () => 2, // 200%
            onClick: (payload) => {
                events.push(payload);
            }
        });
        handle.enable();
        // clientX=140, clientY=110 -> rect-relative offset (40, 60)
        // -> divided by scale (2) -> (20, 30) in PDF points
        const event = new MouseEvent('mousedown', {
            bubbles: true,
            clientX: 140,
            clientY: 110,
            button: 0
        });
        wrapper.dispatchEvent(event);
        expect(events).toHaveLength(1);
        expect(events[0].pageIndex).toBe(2); // page number 3 -> index 2
        expect(events[0].x).toBeCloseTo(20, 5);
        expect(events[0].y).toBeCloseTo(30, 5);
        handle.dispose();
    });

    it('ignores clicks when disabled', () => {
        const events: Array<{ pageIndex: number; x: number; y: number }> = [];
        const handle = attachSignatureAnnotationMode({
            pagesContainer,
            getScale: () => 1,
            onClick: (payload) => {
                events.push(payload);
            }
        });
        const event = new MouseEvent('mousedown', {
            bubbles: true,
            clientX: 200,
            clientY: 200,
            button: 0
        });
        wrapper.dispatchEvent(event);
        expect(events).toHaveLength(0);
        handle.dispose();
    });

    it('ignores clicks that land on an existing signature annotation', () => {
        const events: Array<{ pageIndex: number; x: number; y: number }> = [];
        const handle = attachSignatureAnnotationMode({
            pagesContainer,
            getScale: () => 1,
            onClick: (payload) => {
                events.push(payload);
            }
        });
        handle.enable();

        const existing = document.createElement('img');
        existing.className = 'pv-annotation-signature';
        wrapper.appendChild(existing);
        const event = new MouseEvent('mousedown', {
            bubbles: true,
            clientX: 150,
            clientY: 100,
            button: 0
        });
        existing.dispatchEvent(event);
        expect(events).toHaveLength(0);
        handle.dispose();
    });

    it('dispose() removes the listener and the CSS class', () => {
        const events: Array<{ pageIndex: number; x: number; y: number }> = [];
        const handle = attachSignatureAnnotationMode({
            pagesContainer,
            getScale: () => 1,
            onClick: (payload) => {
                events.push(payload);
            }
        });
        handle.enable();
        handle.dispose();
        const event = new MouseEvent('mousedown', {
            bubbles: true,
            clientX: 150,
            clientY: 100,
            button: 0
        });
        wrapper.dispatchEvent(event);
        expect(events).toHaveLength(0);
        expect(pagesContainer.classList.contains('pv-signature-mode')).toBe(false);
    });
});

describe('default signature annotation constants', () => {
    it('exposes positive default dimensions in PDF points', () => {
        expect(DEFAULT_SIGNATURE_WIDTH).toBeGreaterThan(0);
        expect(DEFAULT_SIGNATURE_HEIGHT).toBeGreaterThan(0);
    });

    it('exposes a CSS color string for the default ink color', () => {
        expect(DEFAULT_SIGNATURE_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
    });
});
