/**
 * Unit tests for issue #14 ResizeManager — pure resize math + the manager's
 * selection-driven handle lifecycle + ElementManager.update integration.
 *
 * Covered DoD items:
 *   - 8-direction resize accuracy (n / s / e / w + ne / nw / se / sw).
 *   - Min-size clamp (12 px) on both axes for every direction.
 *   - Handles attach when SelectionManager has exactly one element, and are
 *     removed when the selection is empty or > 1.
 *   - Mousedown + mousemove on a handle pushes (x, y, w, h) to ElementManager.
 *   - ElementManager.update geometry path mutates DOM inline styles.
 */

import {
    applyResize,
    ALL_HANDLES,
    DEFAULT_MIN_SIZE,
    ResizeManager,
    RESIZE_HANDLE_CLASS
} from '../templates/image/js/ImageEditMode/managers/ResizeManager';
import { ElementManager } from '../templates/image/js/ImageEditMode/managers/ElementManager';
import { SelectionManager } from '../templates/image/js/ImageEditMode/managers/SelectionManager';
import { ToolManager } from '../templates/image/js/ImageEditMode/managers/ToolManager';

describe('applyResize (pure math)', () => {
    const startBox = { x: 100, y: 100, w: 80, h: 60 };

    it('SE handle grows width + height by full delta and shifts center by half', () => {
        const out = applyResize(startBox, 'se', 20, 30);
        expect(out.w).toBe(100);
        expect(out.h).toBe(90);
        expect(out.x).toBe(110); // center = (left + new_right)/2 = (60 + 160)/2
        expect(out.y).toBe(115); // center = (top + new_bottom)/2 = (70 + 160)/2
    });

    it('NW handle shrinks the moving edges and shifts center toward the fixed edge', () => {
        const out = applyResize(startBox, 'nw', 10, 8);
        // left moves +10, top moves +8 -> w shrinks by 10, h shrinks by 8.
        expect(out.w).toBe(70);
        expect(out.h).toBe(52);
        expect(out.x).toBe(105);
        expect(out.y).toBe(104);
    });

    it('N handle moves only the top edge, x and w unchanged', () => {
        const out = applyResize(startBox, 'n', 99, -5);
        expect(out.w).toBe(80);
        expect(out.x).toBe(100);
        expect(out.h).toBe(65);
        expect(out.y).toBe(97.5);
    });

    it('S handle moves only the bottom edge, x and w unchanged', () => {
        const out = applyResize(startBox, 's', -42, 15);
        expect(out.w).toBe(80);
        expect(out.x).toBe(100);
        expect(out.h).toBe(75);
        expect(out.y).toBe(107.5);
    });

    it('E handle moves only the right edge, y and h unchanged', () => {
        const out = applyResize(startBox, 'e', 12, 999);
        expect(out.h).toBe(60);
        expect(out.y).toBe(100);
        expect(out.w).toBe(92);
        expect(out.x).toBe(106);
    });

    it('W handle moves only the left edge, y and h unchanged', () => {
        const out = applyResize(startBox, 'w', -20, -7);
        expect(out.h).toBe(60);
        expect(out.y).toBe(100);
        expect(out.w).toBe(100);
        expect(out.x).toBe(90);
    });

    it('NE handle: width grows with +dx, height shrinks with +dy, center shifts both axes', () => {
        const out = applyResize(startBox, 'ne', 10, 4);
        expect(out.w).toBe(90);
        expect(out.h).toBe(56);
        expect(out.x).toBe(105);
        expect(out.y).toBe(102);
    });

    it('SW handle: width grows with -dx, height grows with +dy', () => {
        const out = applyResize(startBox, 'sw', -10, 6);
        expect(out.w).toBe(90);
        expect(out.h).toBe(66);
        expect(out.x).toBe(95);
        expect(out.y).toBe(103);
    });

    it('clamps width to min size when dragging past zero on E', () => {
        const out = applyResize(startBox, 'e', -1000, 0);
        expect(out.w).toBe(DEFAULT_MIN_SIZE);
        // Right edge pinned at startLeft + min => 60 + 12 = 72.
        expect(out.x).toBe((60 + 72) / 2);
    });

    it('clamps width to min size when dragging past zero on W', () => {
        const out = applyResize(startBox, 'w', 1000, 0);
        expect(out.w).toBe(DEFAULT_MIN_SIZE);
        // Left edge pinned at startRight - min => 140 - 12 = 128.
        expect(out.x).toBe((128 + 140) / 2);
    });

    it('clamps height to min size when dragging past zero on S', () => {
        const out = applyResize(startBox, 's', 0, -1000);
        expect(out.h).toBe(DEFAULT_MIN_SIZE);
        expect(out.y).toBe((70 + 82) / 2);
    });

    it('clamps height to min size when dragging past zero on N', () => {
        const out = applyResize(startBox, 'n', 0, 1000);
        expect(out.h).toBe(DEFAULT_MIN_SIZE);
        // Top pinned at startBottom - min => 130 - 12 = 118.
        expect(out.y).toBe((118 + 130) / 2);
    });

    it('clamps both axes simultaneously on a corner handle', () => {
        const out = applyResize(startBox, 'nw', 1000, 1000);
        expect(out.w).toBe(DEFAULT_MIN_SIZE);
        expect(out.h).toBe(DEFAULT_MIN_SIZE);
    });

    it('honors a custom min-size override', () => {
        const out = applyResize(startBox, 'se', -1000, -1000, 30);
        expect(out.w).toBe(30);
        expect(out.h).toBe(30);
    });

    it('zero delta is identity for every handle', () => {
        for (const handle of ALL_HANDLES) {
            const out = applyResize(startBox, handle, 0, 0);
            expect(out).toEqual(startBox);
        }
    });
});

describe('ElementManager.update (geometry path)', () => {
    let canvas: HTMLElement;
    let em: ElementManager;

    beforeEach(() => {
        document.body.innerHTML = '';
        canvas = document.createElement('div');
        document.body.appendChild(canvas);
        em = new ElementManager({ canvas });
    });

    it('updates inline styles for x/y/w/h', () => {
        const data = em.addRectangle({ x: 100, y: 100, w: 50, h: 40 });
        em.update(data.id, { x: 120, y: 130, w: 80, h: 60 });

        const stored = em.getById(data.id)!;
        expect(stored.x).toBe(120);
        expect(stored.y).toBe(130);
        expect(stored.w).toBe(80);
        expect(stored.h).toBe(60);

        const node = em.getNode(data.id)!;
        expect(node.style.left).toBe('120px');
        expect(node.style.top).toBe('130px');
        expect(node.style.width).toBe('80px');
        expect(node.style.height).toBe('60px');
    });

    it('rebuilds shape SVG when geometry changes', () => {
        const data = em.addRectangle({ x: 0, y: 0, w: 40, h: 40, strokeWidth: 2 });
        em.update(data.id, { w: 120, h: 80 });
        const node = em.getNode(data.id)!;
        const svg = node.querySelector('svg')!;
        expect(svg.getAttribute('width')).toBe('120');
        expect(svg.getAttribute('height')).toBe('80');
        const rect = node.querySelector('rect')!;
        // x/y = strokeWidth/2 = 1. width = 120 - 2 = 118.
        expect(rect.getAttribute('width')).toBe('118');
        expect(rect.getAttribute('height')).toBe('78');
    });

    it('returns undefined for unknown ids and does not throw', () => {
        expect(em.update('does-not-exist', { x: 1 })).toBeUndefined();
    });

    it('shallow-merges style without clobbering unrelated keys', () => {
        const data = em.addCircle({ x: 0, y: 0, w: 50, h: 50, fill: '#ff0000', stroke: '#00ff00', strokeWidth: 4, opacity: 0.8 });
        em.update(data.id, { style: { fill: '#0000ff' } });
        const stored = em.getById(data.id)!;
        expect(stored.style.fill).toBe('#0000ff');
        expect(stored.style.stroke).toBe('#00ff00');
        expect(stored.style.strokeWidth).toBe(4);
        expect(stored.style.opacity).toBe(0.8);
    });

    it('text update changes text + node textContent', () => {
        const data = em.addText({ x: 0, y: 0, text: 'one' });
        em.update(data.id, { text: 'two' });
        expect(em.getById(data.id)!.text).toBe('two');
        expect(em.getNode(data.id)!.textContent).toBe('two');
    });

    it('fires listeners only when something actually changed', () => {
        const data = em.addText({ x: 10, y: 20 });
        const seen: number[] = [];
        em.subscribe(() => seen.push(1));
        em.update(data.id, { x: 10, y: 20 }); // no-op
        expect(seen).toEqual([]);
        em.update(data.id, { x: 11 });
        expect(seen).toEqual([1]);
    });
});

describe('ResizeManager (selection-driven handle lifecycle)', () => {
    let canvas: HTMLElement;
    let em: ElementManager;
    let sm: SelectionManager;
    let tm: ToolManager;
    let rm: ResizeManager;

    beforeEach(() => {
        document.body.innerHTML = '';
        canvas = document.createElement('div');
        document.body.appendChild(canvas);
        em = new ElementManager({ canvas });
        sm = new SelectionManager({ elementManager: em });
        tm = new ToolManager({ initialTool: 'select' });
        rm = new ResizeManager({ elementManager: em, selectionManager: sm, toolManager: tm });
    });

    afterEach(() => {
        rm.dispose();
        sm.dispose();
        em.dispose();
        tm.dispose();
    });

    it('attaches 8 handles when exactly one element is selected', () => {
        const a = em.addRectangle({ x: 0, y: 0, w: 50, h: 50 });
        sm.select(a.id);
        const handles = rm.getHandles(a.id);
        expect(handles).toHaveLength(8);
        const dirs = handles.map((h) => h.dataset.handle).sort();
        expect(dirs).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
        const node = em.getNode(a.id)!;
        expect(node.querySelectorAll(`.${RESIZE_HANDLE_CLASS}`)).toHaveLength(8);
    });

    it('removes handles when selection is cleared', () => {
        const a = em.addRectangle({ x: 0, y: 0, w: 50, h: 50 });
        sm.select(a.id);
        expect(rm.getHandles(a.id)).toHaveLength(8);
        sm.clear();
        expect(rm.getHandles(a.id)).toHaveLength(0);
        const node = em.getNode(a.id)!;
        expect(node.querySelectorAll(`.${RESIZE_HANDLE_CLASS}`)).toHaveLength(0);
    });

    it('removes handles when selection grows beyond one', () => {
        const a = em.addRectangle({ x: 0, y: 0, w: 50, h: 50 });
        const b = em.addRectangle({ x: 80, y: 80, w: 40, h: 40 });
        sm.select(a.id);
        expect(rm.getHandles(a.id)).toHaveLength(8);
        sm.addToSelection(b.id);
        expect(rm.getHandles(a.id)).toHaveLength(0);
        expect(rm.getHandles(b.id)).toHaveLength(0);
    });

    it('moves handles to a new element when the single-selection switches', () => {
        const a = em.addRectangle({ x: 0, y: 0, w: 50, h: 50 });
        const b = em.addRectangle({ x: 80, y: 80, w: 40, h: 40 });
        sm.select(a.id);
        expect(rm.getHandles(a.id)).toHaveLength(8);
        sm.select(b.id);
        expect(rm.getHandles(a.id)).toHaveLength(0);
        expect(rm.getHandles(b.id)).toHaveLength(8);
    });

    it('mousedown + mousemove on the SE handle pushes new geometry through ElementManager', () => {
        const a = em.addRectangle({ x: 100, y: 100, w: 50, h: 50 });
        sm.select(a.id);
        const handles = rm.getHandles(a.id);
        const se = handles.find((h) => h.dataset.handle === 'se')!;

        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 200 });
        se.dispatchEvent(down);

        const move = new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 240, clientY: 220 });
        document.dispatchEvent(move);

        const stored = em.getById(a.id)!;
        // SE: w += 40, h += 20, center shifts by (20, 10).
        expect(stored.w).toBe(90);
        expect(stored.h).toBe(70);
        expect(stored.x).toBe(120);
        expect(stored.y).toBe(110);

        const up = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
        document.dispatchEvent(up);
        expect(rm.isResizingActive()).toBe(false);
    });

    it('does not start a resize when the active tool is not select', () => {
        const a = em.addRectangle({ x: 100, y: 100, w: 50, h: 50 });
        sm.select(a.id);
        const se = rm.getHandles(a.id).find((h) => h.dataset.handle === 'se')!;
        tm.activate('rect');
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
        se.dispatchEvent(down);
        expect(rm.isResizingActive()).toBe(false);
    });

    it('resizing stops at min size even when dragging past zero', () => {
        const a = em.addRectangle({ x: 100, y: 100, w: 50, h: 50 });
        sm.select(a.id);
        const nw = rm.getHandles(a.id).find((h) => h.dataset.handle === 'nw')!;

        nw.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 1000, clientY: 1000 }));

        const stored = em.getById(a.id)!;
        expect(stored.w).toBe(DEFAULT_MIN_SIZE);
        expect(stored.h).toBe(DEFAULT_MIN_SIZE);
    });
});
