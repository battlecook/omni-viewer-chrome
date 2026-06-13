/**
 * Unit tests for the issue #12 ElementManager + canvas-click integration.
 *
 * Covered DoD items:
 *   - addText / addCircle / addRectangle render the right DOM/SVG
 *   - color, opacity, fontSize, stroke applied per spec
 *   - list / count / getById / getNode read back what was created
 *   - subscribe fires on create + clear (and unsubscribe stops it)
 *   - serialize returns a deep copy with the documented data shape
 *   - clear removes nodes from the canvas + resets id sequence
 *   - setCanvas re-parents existing nodes
 *   - mountImageEditMode click handler creates elements only when enabled +
 *     the active tool is text/circle/rect, and routes through promptText
 */

import {
    ElementManager,
    ElementData,
    ElementType
} from '../templates/image/js/ImageEditMode/managers/ElementManager';
import { mountImageEditMode } from '../templates/image/js/ImageEditMode';

describe('ElementManager', () => {
    let canvas: HTMLElement;
    let em: ElementManager;

    beforeEach(() => {
        document.body.innerHTML = '';
        canvas = document.createElement('div');
        document.body.appendChild(canvas);
        em = new ElementManager({ canvas });
    });

    it('starts empty', () => {
        expect(em.list()).toEqual([]);
        expect(em.count()).toBe(0);
        expect(em.getCanvas()).toBe(canvas);
    });

    it('addText creates an absolutely-positioned div with color/font-size/opacity applied', () => {
        const data = em.addText({
            x: 50,
            y: 70,
            text: 'Hello',
            fontSize: 32,
            color: '#112233',
            opacity: 0.5
        });

        expect(data.id).toBe('el-1');
        expect(data.type).toBe('text');
        expect(data.x).toBe(50);
        expect(data.y).toBe(70);
        expect(data.text).toBe('Hello');
        expect(data.style.fill).toBe('#112233');
        expect(data.style.fontSize).toBe(32);
        expect(data.style.opacity).toBe(0.5);

        const node = em.getNode(data.id) as HTMLElement;
        expect(node).toBeTruthy();
        expect(node.parentElement).toBe(canvas);
        expect(node.classList.contains('iv-edit-element')).toBe(true);
        expect(node.classList.contains('iv-edit-text')).toBe(true);
        expect(node.dataset.elementId).toBe(data.id);
        expect(node.dataset.elementType).toBe('text');
        expect(node.textContent).toBe('Hello');
        expect(node.style.position).toBe('absolute');
        expect(node.style.left).toBe('50px');
        expect(node.style.top).toBe('70px');
        expect(node.style.fontSize).toBe('32px');
        expect(node.style.color).toBe('rgb(17, 34, 51)');
        expect(node.style.opacity).toBe('0.5');
    });

    it('addText falls back to defaults when fields are omitted', () => {
        const data = em.addText({ x: 10, y: 20 });
        expect(data.text).toBe('Text');
        expect(data.style.fontSize).toBe(24);
        expect(data.style.opacity).toBe(1);
        expect(typeof data.style.fill).toBe('string');
    });

    it('addCircle creates an SVG <circle> with fill/stroke/opacity applied', () => {
        const data = em.addCircle({
            x: 100,
            y: 100,
            w: 60,
            h: 60,
            fill: '#ff0000',
            stroke: '#00ff00',
            strokeWidth: 4,
            opacity: 0.8
        });

        expect(data.type).toBe('circle');
        expect(data.w).toBe(60);
        expect(data.h).toBe(60);
        expect(data.style.fill).toBe('#ff0000');
        expect(data.style.stroke).toBe('#00ff00');
        expect(data.style.strokeWidth).toBe(4);
        expect(data.style.opacity).toBe(0.8);

        const node = em.getNode(data.id) as HTMLElement;
        expect(node.classList.contains('iv-edit-circle')).toBe(true);
        expect(node.style.opacity).toBe('0.8');

        const svg = node.querySelector('svg');
        expect(svg).toBeTruthy();
        expect(svg!.getAttribute('width')).toBe('60');
        expect(svg!.getAttribute('height')).toBe('60');

        const circle = node.querySelector('circle');
        expect(circle).toBeTruthy();
        expect(circle!.getAttribute('fill')).toBe('#ff0000');
        expect(circle!.getAttribute('stroke')).toBe('#00ff00');
        expect(circle!.getAttribute('stroke-width')).toBe('4');
        // r = min(w,h)/2 - strokeWidth/2 = 30 - 2 = 28
        expect(circle!.getAttribute('r')).toBe('28');
        expect(circle!.getAttribute('cx')).toBe('30');
        expect(circle!.getAttribute('cy')).toBe('30');
    });

    it('addRectangle creates an SVG <rect> with fill/stroke/opacity applied', () => {
        const data = em.addRectangle({
            x: 200,
            y: 80,
            w: 120,
            h: 40,
            fill: '#abcdef',
            stroke: '#222222',
            strokeWidth: 2,
            opacity: 1
        });

        expect(data.type).toBe('rect');
        expect(data.w).toBe(120);
        expect(data.h).toBe(40);

        const node = em.getNode(data.id) as HTMLElement;
        expect(node.classList.contains('iv-edit-rect')).toBe(true);
        expect(node.style.left).toBe('200px');
        expect(node.style.top).toBe('80px');
        expect(node.style.width).toBe('120px');
        expect(node.style.height).toBe('40px');

        const rect = node.querySelector('rect');
        expect(rect).toBeTruthy();
        expect(rect!.getAttribute('fill')).toBe('#abcdef');
        expect(rect!.getAttribute('stroke')).toBe('#222222');
        expect(rect!.getAttribute('stroke-width')).toBe('2');
        // x = strokeWidth/2 = 1, width = w - strokeWidth = 118
        expect(rect!.getAttribute('x')).toBe('1');
        expect(rect!.getAttribute('y')).toBe('1');
        expect(rect!.getAttribute('width')).toBe('118');
        expect(rect!.getAttribute('height')).toBe('38');
    });

    it('create() dispatches based on type', () => {
        const text = em.create('text', 1, 2, { text: 'hi' });
        const circle = em.create('circle', 3, 4);
        const rect = em.create('rect', 5, 6);
        expect(text.type).toBe('text');
        expect(circle.type).toBe('circle');
        expect(rect.type).toBe('rect');
        expect(em.count()).toBe(3);
    });

    it('mints stable, unique ids in creation order', () => {
        const a = em.addCircle({ x: 0, y: 0 });
        const b = em.addCircle({ x: 0, y: 0 });
        const c = em.addRectangle({ x: 0, y: 0 });
        expect(a.id).toBe('el-1');
        expect(b.id).toBe('el-2');
        expect(c.id).toBe('el-3');
        expect(em.getById('el-2')).toBe(b);
        expect(em.getById('missing')).toBeUndefined();
    });

    it('list() returns a snapshot (mutating the result does not affect state)', () => {
        em.addCircle({ x: 0, y: 0 });
        const snap = em.list() as ElementData[];
        snap.length = 0;
        expect(em.count()).toBe(1);
    });

    it('subscribe fires on every create + clear; unsubscribe stops events', () => {
        const sizes: number[] = [];
        const off = em.subscribe((els) => sizes.push(els.length));

        em.addText({ x: 0, y: 0 });
        em.addCircle({ x: 0, y: 0 });
        em.clear();
        off();
        em.addRectangle({ x: 0, y: 0 });

        expect(sizes).toEqual([1, 2, 0]);
    });

    it('a misbehaving listener does not break the manager', () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        em.subscribe(() => {
            throw new Error('boom');
        });
        const ok: number[] = [];
        em.subscribe((els) => ok.push(els.length));
        em.addText({ x: 0, y: 0 });
        expect(em.count()).toBe(1);
        expect(ok).toEqual([1]);
        errSpy.mockRestore();
    });

    it('serialize returns a deep copy', () => {
        em.addText({ x: 1, y: 2, text: 'A', color: '#abcdef' });
        const snap = em.serialize();
        expect(snap).toHaveLength(1);
        expect(snap[0].text).toBe('A');
        snap[0].text = 'B';
        snap[0].style.fill = '#000000';
        // Live data unchanged.
        expect(em.list()[0].text).toBe('A');
        expect(em.list()[0].style.fill).toBe('#abcdef');
    });

    it('clear removes nodes from the canvas + resets the id counter', () => {
        em.addText({ x: 0, y: 0 });
        em.addCircle({ x: 0, y: 0 });
        expect(canvas.children.length).toBe(2);

        em.clear();
        expect(canvas.children.length).toBe(0);
        expect(em.count()).toBe(0);

        const next = em.addCircle({ x: 0, y: 0 });
        expect(next.id).toBe('el-1');
    });

    it('setCanvas re-parents existing nodes', () => {
        em.addCircle({ x: 0, y: 0 });
        const other = document.createElement('div');
        document.body.appendChild(other);

        em.setCanvas(other);
        expect(canvas.children.length).toBe(0);
        expect(other.children.length).toBe(1);
        expect(em.getCanvas()).toBe(other);
    });

    it('clamps opacity outside [0, 1]', () => {
        const high = em.addCircle({ x: 0, y: 0, opacity: 5 });
        const low = em.addCircle({ x: 0, y: 0, opacity: -3 });
        expect(high.style.opacity).toBe(1);
        expect(low.style.opacity).toBe(0);
    });

    it('z-index increases for each new element', () => {
        const a = em.addText({ x: 0, y: 0 });
        const b = em.addCircle({ x: 0, y: 0 });
        const za = parseInt((em.getNode(a.id) as HTMLElement).style.zIndex, 10);
        const zb = parseInt((em.getNode(b.id) as HTMLElement).style.zIndex, 10);
        expect(zb).toBeGreaterThan(za);
    });

    it('handles types via exhaustive create()', () => {
        const types: ElementType[] = ['text', 'circle', 'rect'];
        for (const t of types) {
            em.create(t, 0, 0);
        }
        expect(em.count()).toBe(3);
    });

    it('dispose drops every element + clears state', () => {
        em.addText({ x: 0, y: 0 });
        em.dispose();
        expect(canvas.children.length).toBe(0);
        expect(em.count()).toBe(0);
        expect(em.getCanvas()).toBeUndefined();
    });
});

describe('mountImageEditMode canvas-click element creation', () => {
    let host: HTMLElement;

    beforeEach(() => {
        document.body.innerHTML = '';
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    function dispatchClick(target: HTMLElement, x = 12, y = 24): void {
        const evt = new MouseEvent('click', {
            bubbles: true,
            clientX: x,
            clientY: y
        });
        target.dispatchEvent(evt);
    }

    it('exposes the elementManager + edit canvas on the handle', () => {
        const handle = mountImageEditMode({ host });
        expect(handle.elementManager).toBeDefined();
        expect(handle.editCanvas).toBeInstanceOf(HTMLElement);
        expect(handle.editCanvas.classList.contains('iv-edit-canvas')).toBe(true);
        // Auto-built canvas is parented to the host.
        expect(handle.editCanvas.parentElement).toBe(host);
        handle.dispose();
    });

    it('clicking the canvas while in circle tool creates a circle element', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();
        handle.toolManager.activate('circle');

        dispatchClick(handle.editCanvas, 50, 50);
        expect(handle.elementManager.count()).toBe(1);
        expect(handle.elementManager.list()[0].type).toBe('circle');

        handle.dispose();
    });

    it('clicking the canvas while in rect tool creates a rect element', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();
        handle.toolManager.activate('rect');

        dispatchClick(handle.editCanvas, 30, 40);
        expect(handle.elementManager.count()).toBe(1);
        expect(handle.elementManager.list()[0].type).toBe('rect');

        handle.dispose();
    });

    it('text tool routes through promptText and stores the user input', () => {
        const promptText = jest.fn().mockReturnValue('Hello world');
        const handle = mountImageEditMode({ host, promptText });
        handle.enable();
        handle.toolManager.activate('text');

        dispatchClick(handle.editCanvas, 5, 5);
        expect(promptText).toHaveBeenCalledTimes(1);
        expect(handle.elementManager.count()).toBe(1);
        expect(handle.elementManager.list()[0].text).toBe('Hello world');

        handle.dispose();
    });

    it('cancelling the text prompt aborts the creation', () => {
        const promptText = jest.fn().mockReturnValue(null);
        const handle = mountImageEditMode({ host, promptText });
        handle.enable();
        handle.toolManager.activate('text');

        dispatchClick(handle.editCanvas, 5, 5);
        expect(handle.elementManager.count()).toBe(0);
        handle.dispose();
    });

    it('does NOT create an element when edit mode is disabled', () => {
        const handle = mountImageEditMode({ host });
        // Skip enable() — but force a creation tool anyway.
        handle.toolManager.activate('circle');

        dispatchClick(handle.editCanvas, 0, 0);
        expect(handle.elementManager.count()).toBe(0);
        handle.dispose();
    });

    it('does NOT create an element when the active tool is select / delete', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();

        // select is active by default.
        dispatchClick(handle.editCanvas, 0, 0);
        expect(handle.elementManager.count()).toBe(0);

        handle.toolManager.activate('delete');
        dispatchClick(handle.editCanvas, 0, 0);
        expect(handle.elementManager.count()).toBe(0);

        handle.dispose();
    });

    it('does NOT create when the click target is a child element (so #13 can own selection)', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();
        handle.toolManager.activate('circle');

        dispatchClick(handle.editCanvas, 10, 10);
        expect(handle.elementManager.count()).toBe(1);

        // Click on the existing element instead of the canvas.
        const child = handle.editCanvas.firstElementChild as HTMLElement;
        expect(child).toBeTruthy();
        dispatchClick(child, 10, 10);

        // Still just one element — child clicks don't count.
        expect(handle.elementManager.count()).toBe(1);
        handle.dispose();
    });

    it('onElementCreate fires for canvas-driven creations only', () => {
        const onElementCreate = jest.fn();
        const handle = mountImageEditMode({ host, onElementCreate });
        handle.enable();
        handle.toolManager.activate('circle');

        dispatchClick(handle.editCanvas, 1, 1);
        expect(onElementCreate).toHaveBeenCalledTimes(1);
        expect(onElementCreate.mock.calls[0][0].type).toBe('circle');

        // Direct manager calls do NOT fire the callback — that's deliberate;
        // the callback is for canvas-click flows specifically.
        handle.elementManager.addRectangle({ x: 0, y: 0 });
        expect(onElementCreate).toHaveBeenCalledTimes(1);

        handle.dispose();
    });

    it('dispose removes the auto-built canvas from the host', () => {
        const handle = mountImageEditMode({ host });
        expect(host.querySelector('.iv-edit-canvas')).toBeTruthy();
        handle.dispose();
        expect(host.querySelector('.iv-edit-canvas')).toBeNull();
    });
});
