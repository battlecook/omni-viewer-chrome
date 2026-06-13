// Unit tests for the PDF annotation selection / drag / delete primitives
// (issue #21).
//
// Coverage:
//   - Pure helpers: `screenDeltaToPdfPoints`, `isAnnotationTarget`,
//     `isEditableTarget`, `dragReducer`.
//   - Integrated `attachSelectionLayer` behavior:
//     * Click on an annotation in View mode selects it (one at a time).
//     * Esc clears the selection.
//     * Delete / Backspace removes the selected annotation; ignored when
//       focus is inside an editable element.
//     * Drag (mousedown + mousemove + mouseup) commits the new x/y to
//       the store via `updateAnnotation`, with screen-px deltas
//       converted back to PDF points using `delta / scale`.
//     * Coordinate accuracy holds across zoom changes (scale=2 halves
//       the PDF-point delta vs. the screen-px delta).
//     * `disable()` releases the grip (mode mutual exclusion with
//       Text/Signature).

import {
    SELECTED_CLASS,
    attachSelectionLayer,
    dragReducer,
    isAnnotationTarget,
    isEditableTarget,
    screenDeltaToPdfPoints
} from '../templates/pdf/js/annotations/selection';
import {
    createPdfAnnotationStore,
    PdfAnnotationStore,
    PdfTextAnnotation
} from '../templates/pdf/js/pdfAnnotationStore';

// --- pure helpers -----------------------------------------------------

describe('screenDeltaToPdfPoints', () => {
    it('halves a screen-px delta when scale is 2', () => {
        expect(screenDeltaToPdfPoints(40, 60, 2)).toEqual({ dx: 20, dy: 30 });
    });

    it('passes through deltas at scale 1.0', () => {
        expect(screenDeltaToPdfPoints(15, -25, 1)).toEqual({ dx: 15, dy: -25 });
    });

    it('doubles a screen-px delta when scale is 0.5', () => {
        expect(screenDeltaToPdfPoints(10, 10, 0.5)).toEqual({ dx: 20, dy: 20 });
    });

    it('treats scale=0 as a no-op rather than dividing by zero', () => {
        expect(screenDeltaToPdfPoints(50, 50, 0)).toEqual({ dx: 0, dy: 0 });
    });
});

describe('isAnnotationTarget', () => {
    it('returns the id and node for a text annotation element', () => {
        const node = document.createElement('div');
        node.className = 'pv-annotation-text';
        node.dataset.annotationId = 'text-1';
        const hit = isAnnotationTarget(node);
        expect(hit?.id).toBe('text-1');
        expect(hit?.node).toBe(node);
    });

    it('returns the id and node for a signature annotation element', () => {
        const node = document.createElement('img');
        node.className = 'pv-annotation-signature';
        node.dataset.annotationId = 'signature-7';
        const hit = isAnnotationTarget(node);
        expect(hit?.id).toBe('signature-7');
        expect(hit?.node).toBe(node);
    });

    it('walks up the DOM to find the nearest annotation ancestor', () => {
        const node = document.createElement('div');
        node.className = 'pv-annotation-text';
        node.dataset.annotationId = 'text-2';
        const inner = document.createElement('span');
        node.appendChild(inner);
        const hit = isAnnotationTarget(inner);
        expect(hit?.id).toBe('text-2');
    });

    it('returns undefined for a non-annotation target', () => {
        const node = document.createElement('div');
        expect(isAnnotationTarget(node)).toBeUndefined();
    });

    it('returns undefined for a null target', () => {
        expect(isAnnotationTarget(null)).toBeUndefined();
    });

    it('returns undefined when the annotation node is missing its id', () => {
        const node = document.createElement('div');
        node.className = 'pv-annotation-text';
        expect(isAnnotationTarget(node)).toBeUndefined();
    });
});

describe('isEditableTarget', () => {
    it('returns true for INPUT', () => {
        expect(isEditableTarget(document.createElement('input'))).toBe(true);
    });
    it('returns true for TEXTAREA', () => {
        expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    });
    it('returns true for SELECT', () => {
        expect(isEditableTarget(document.createElement('select'))).toBe(true);
    });
    it('returns true for contentEditable elements', () => {
        const div = document.createElement('div');
        Object.defineProperty(div, 'isContentEditable', { value: true });
        expect(isEditableTarget(div)).toBe(true);
    });
    it('returns false for plain div', () => {
        expect(isEditableTarget(document.createElement('div'))).toBe(false);
    });
    it('returns false for null', () => {
        expect(isEditableTarget(null)).toBe(false);
    });
});

describe('dragReducer', () => {
    it('starts in the idle state and transitions to dragging on begin', () => {
        const next = dragReducer(
            { status: 'idle' },
            {
                type: 'begin',
                id: 'text-1',
                startX: 100,
                startY: 200,
                pointerStartX: 50,
                pointerStartY: 60
            }
        );
        expect(next.status).toBe('dragging');
        if (next.status === 'dragging') {
            expect(next.id).toBe('text-1');
            expect(next.startX).toBe(100);
            expect(next.startY).toBe(200);
            expect(next.pointerStartX).toBe(50);
            expect(next.pointerStartY).toBe(60);
            expect(next.currentX).toBe(100);
            expect(next.currentY).toBe(200);
        }
    });

    it('updates currentX/currentY on move using delta / scale', () => {
        const begun = dragReducer(
            { status: 'idle' },
            {
                type: 'begin',
                id: 'text-1',
                startX: 100,
                startY: 200,
                pointerStartX: 50,
                pointerStartY: 60
            }
        );
        const moved = dragReducer(begun, {
            type: 'move',
            pointerX: 110,
            pointerY: 80,
            scale: 2
        });
        // pointer moved (60, 20) px @ scale 2 → (30, 10) PDF points.
        expect(moved.status).toBe('dragging');
        if (moved.status === 'dragging') {
            expect(moved.currentX).toBe(130);
            expect(moved.currentY).toBe(210);
        }
    });

    it('returns to idle on commit', () => {
        const begun = dragReducer(
            { status: 'idle' },
            {
                type: 'begin',
                id: 'a',
                startX: 0,
                startY: 0,
                pointerStartX: 0,
                pointerStartY: 0
            }
        );
        const committed = dragReducer(begun, { type: 'commit' });
        expect(committed.status).toBe('idle');
    });

    it('returns to idle on cancel', () => {
        const begun = dragReducer(
            { status: 'idle' },
            {
                type: 'begin',
                id: 'a',
                startX: 0,
                startY: 0,
                pointerStartX: 0,
                pointerStartY: 0
            }
        );
        const cancelled = dragReducer(begun, { type: 'cancel' });
        expect(cancelled.status).toBe('idle');
    });

    it('ignores move actions while idle', () => {
        const next = dragReducer(
            { status: 'idle' },
            { type: 'move', pointerX: 100, pointerY: 100, scale: 1 }
        );
        expect(next.status).toBe('idle');
    });
});

// --- attachSelectionLayer integration ---------------------------------

interface Harness {
    store: PdfAnnotationStore;
    overlayLayer: HTMLElement;
    selection: ReturnType<typeof attachSelectionLayer>;
    setScale(next: number): void;
    annotationNode(id: string): HTMLElement;
    addNode(annotation: { id: string; kind: 'text' | 'signature'; left: number; top: number }): HTMLElement;
}

function buildHarness(initialScale = 1): Harness {
    const overlayLayer = document.createElement('div');
    overlayLayer.id = 'pv-overlayLayer';
    document.body.appendChild(overlayLayer);
    let scale = initialScale;
    const store = createPdfAnnotationStore();
    const selection = attachSelectionLayer({
        store,
        overlayLayer,
        getCurrentScale: () => scale
    });
    const harness: Harness = {
        store,
        overlayLayer,
        selection,
        setScale(next: number): void {
            scale = next;
        },
        annotationNode(id: string): HTMLElement {
            const node = overlayLayer.querySelector<HTMLElement>(
                `[data-annotation-id="${id}"]`
            );
            if (!node) throw new Error(`no node for id ${id}`);
            return node;
        },
        addNode({ id, kind, left, top }): HTMLElement {
            const node =
                kind === 'text'
                    ? document.createElement('div')
                    : document.createElement('img');
            node.className =
                kind === 'text' ? 'pv-annotation-text' : 'pv-annotation-signature';
            node.dataset.annotationId = id;
            node.style.position = 'absolute';
            node.style.left = `${left}px`;
            node.style.top = `${top}px`;
            overlayLayer.appendChild(node);
            return node;
        }
    };
    return harness;
}

function teardownHarness(h: Harness): void {
    h.selection.dispose();
    h.overlayLayer.remove();
}

afterEach(() => {
    // Tidy any stray context menus from the body.
    document
        .querySelectorAll('.pv-annotation-context-menu')
        .forEach((el) => el.remove());
});

describe('attachSelectionLayer: click to select', () => {
    it('selects an annotation on left mousedown and applies the selected class', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 10,
            y: 20,
            text: 'hi',
            size: 16,
            color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 100, top: 200 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBe(id);
        expect(node.classList.contains(SELECTED_CLASS)).toBe(true);
        teardownHarness(h);
    });

    it('only one annotation is selected at a time', () => {
        const h = buildHarness();
        const idA = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const idB = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 5, y: 5,
            text: 'b', size: 16, color: '#000'
        });
        const nodeA = h.addNode({ id: idA, kind: 'text', left: 0, top: 0 });
        const nodeB = h.addNode({ id: idB, kind: 'text', left: 30, top: 30 });
        nodeA.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBe(idA);
        nodeB.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBe(idB);
        expect(nodeA.classList.contains(SELECTED_CLASS)).toBe(false);
        expect(nodeB.classList.contains(SELECTED_CLASS)).toBe(true);
        teardownHarness(h);
    });

    it('Esc clears the selection', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBe(id);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(h.selection.getSelectedId()).toBeUndefined();
        expect(node.classList.contains(SELECTED_CLASS)).toBe(false);
        teardownHarness(h);
    });
});

describe('attachSelectionLayer: keyboard delete', () => {
    it('Delete removes the selected annotation from the store', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
        expect(h.store.getAnnotation(id)).toBeUndefined();
        expect(h.selection.getSelectedId()).toBeUndefined();
        teardownHarness(h);
    });

    it('Backspace removes the selected annotation', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
        expect(h.store.getAnnotation(id)).toBeUndefined();
        teardownHarness(h);
    });

    it('Delete is ignored when focus is inside an input', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        // Dispatch a Delete keypress whose event.target is an INPUT element.
        const input = document.createElement('input');
        document.body.appendChild(input);
        const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true });
        input.dispatchEvent(ev);
        expect(h.store.getAnnotation(id)).toBeDefined();
        input.remove();
        teardownHarness(h);
    });
});

describe('attachSelectionLayer: drag to move', () => {
    it('commits new x/y to the store using delta / scale on mouseup', () => {
        const h = buildHarness(1);
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 100,
            y: 200,
            text: 'drag me',
            size: 16,
            color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 100, top: 200 });
        node.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientX: 0, clientY: 0
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientX: 30, clientY: 40
        }));
        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: 30, clientY: 40
        }));
        const updated = h.store.getAnnotation(id) as PdfTextAnnotation;
        // delta=(30,40) px @ scale 1 → +30, +40 PDF points.
        expect(updated.x).toBeCloseTo(130, 5);
        expect(updated.y).toBeCloseTo(240, 5);
        teardownHarness(h);
    });

    it('halves the PDF-point delta at scale=2 (zoom-stable coordinates)', () => {
        const h = buildHarness(2);
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0,
            x: 100,
            y: 200,
            text: 'zoom drag',
            size: 16,
            color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 200, top: 400 });
        node.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientX: 0, clientY: 0
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientX: 40, clientY: 60
        }));
        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: 40, clientY: 60
        }));
        const updated = h.store.getAnnotation(id) as PdfTextAnnotation;
        // At scale=2, screen delta (40, 60) → PDF delta (20, 30).
        expect(updated.x).toBeCloseTo(120, 5);
        expect(updated.y).toBeCloseTo(230, 5);
        teardownHarness(h);
    });

    it('does not mutate the store on a tiny mousedown→mouseup with no real movement', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 50, y: 50,
            text: 'static', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 50, top: 50 });
        node.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientX: 100, clientY: 100
        }));
        // No mousemove — straight to mouseup at the same client coords.
        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: 100, clientY: 100
        }));
        const same = h.store.getAnnotation(id) as PdfTextAnnotation;
        expect(same.x).toBe(50);
        expect(same.y).toBe(50);
        teardownHarness(h);
    });
});

describe('attachSelectionLayer: enable / disable', () => {
    it('disable() drops the current selection and ignores subsequent clicks', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBe(id);
        h.selection.disable();
        expect(h.selection.getSelectedId()).toBeUndefined();
        // A subsequent mousedown while disabled must not select.
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBeUndefined();
        teardownHarness(h);
    });

    it('enable() restores click-to-select after disable()', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        h.selection.disable();
        h.selection.enable();
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(h.selection.getSelectedId()).toBe(id);
        teardownHarness(h);
    });
});

describe('attachSelectionLayer: refresh after store mutation', () => {
    it('keeps the selected class on a node whose DOM has been re-created', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        let node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(node.classList.contains(SELECTED_CLASS)).toBe(true);

        // Simulate a repaint: drop the existing node, add a fresh one,
        // mutate the store (triggers `onChange` → selection refresh).
        node.remove();
        node = h.addNode({ id, kind: 'text', left: 10, top: 10 });
        h.store.updateAnnotation(id, { x: 1 });
        // After the mutation the change-listener fires `refresh()`; the
        // new node should now carry the selected class.
        expect(node.classList.contains(SELECTED_CLASS)).toBe(true);
        teardownHarness(h);
    });
});

describe('attachSelectionLayer: right-click context menu', () => {
    it('shows a Delete option that removes the annotation', () => {
        const h = buildHarness();
        const id = h.store.addAnnotation({
            kind: 'text',
            pageIndex: 0, x: 0, y: 0,
            text: 'a', size: 16, color: '#000'
        });
        const node = h.addNode({ id, kind: 'text', left: 0, top: 0 });
        node.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, button: 2, clientX: 50, clientY: 80
        }));
        const menu = document.querySelector('.pv-annotation-context-menu');
        expect(menu).not.toBeNull();
        const deleteBtn = menu!.querySelector<HTMLButtonElement>(
            '.pv-annotation-context-item'
        );
        expect(deleteBtn?.textContent).toBe('Delete');
        deleteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(h.store.getAnnotation(id)).toBeUndefined();
        expect(document.querySelector('.pv-annotation-context-menu')).toBeNull();
        teardownHarness(h);
    });
});
