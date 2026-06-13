/**
 * Unit tests for the issue #13 SelectionManager + DragDropManager + the
 * mountImageEditMode wiring around them.
 *
 * Covered DoD items:
 *   - Single-select via click.
 *   - Multi-select via Shift+click (toggle add / remove).
 *   - Click on empty canvas clears selection.
 *   - Drag updates `element.x / y` accurately for single + multi select.
 *   - `.is-selected` class lifecycle (added on select, removed on deselect).
 *   - `#selectionInfo` span shows "N selected" when ≥1.
 *   - `Delete` / `Backspace` keys remove all selected.
 *   - `#deleteSelected` button mirrors keyboard delete.
 *   - Drag is ignored when target is the canvas background.
 *   - Drag is ignored when active tool is not 'select'.
 */

import { ElementManager } from '../templates/image/js/ImageEditMode/managers/ElementManager';
import { ToolManager } from '../templates/image/js/ImageEditMode/managers/ToolManager';
import {
    SelectionManager,
    SELECTED_CLASS
} from '../templates/image/js/ImageEditMode/managers/SelectionManager';
import {
    DragDropManager,
    updateElementPosition
} from '../templates/image/js/ImageEditMode/managers/DragDropManager';
import {
    mountImageEditMode,
    SELECTION_INFO_ID,
    DELETE_SELECTED_ID
} from '../templates/image/js/ImageEditMode';

/** Build a fresh canvas + ElementManager + SelectionManager triplet. */
function makeRig(): {
    canvas: HTMLElement;
    em: ElementManager;
    sm: SelectionManager;
} {
    document.body.innerHTML = '';
    const canvas = document.createElement('div');
    document.body.appendChild(canvas);
    const em = new ElementManager({ canvas });
    const sm = new SelectionManager({ elementManager: em });
    return { canvas, em, sm };
}

/** Dispatch a synthetic mouse event of `type` on `target` with given client coords. */
function fireMouse(
    target: EventTarget,
    type: 'mousedown' | 'mousemove' | 'mouseup' | 'click',
    clientX = 0,
    clientY = 0,
    init: MouseEventInit = {}
): MouseEvent {
    const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
        ...init
    });
    target.dispatchEvent(ev);
    return ev;
}

describe('SelectionManager', () => {
    it('starts empty', () => {
        const { sm } = makeRig();
        expect(sm.count()).toBe(0);
        expect(sm.list()).toEqual([]);
        expect(sm.has('el-1')).toBe(false);
    });

    it('select(id) replaces the selection with a single id', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const b = em.addText({ x: 20, y: 20, text: 'B' });

        sm.select(a.id);
        expect(sm.list()).toEqual([a.id]);

        sm.select(b.id);
        expect(sm.list()).toEqual([b.id]);
        expect(sm.has(a.id)).toBe(false);
    });

    it('addToSelection(id) toggles membership without dropping others', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const b = em.addText({ x: 20, y: 20, text: 'B' });
        const c = em.addText({ x: 30, y: 30, text: 'C' });

        sm.select(a.id);
        sm.addToSelection(b.id);
        sm.addToSelection(c.id);
        expect(sm.list()).toEqual([a.id, b.id, c.id]);

        sm.addToSelection(b.id); // toggle off
        expect(sm.list()).toEqual([a.id, c.id]);
    });

    it('clear() drops everything and is idempotent', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        sm.select(a.id);
        sm.clear();
        expect(sm.count()).toBe(0);
        // Calling clear again should not throw and not re-fire listeners.
        const seen: number[] = [];
        sm.subscribe((ids) => seen.push(ids.length));
        sm.clear();
        expect(seen).toEqual([]);
    });

    it('paints + strips `.is-selected` on element nodes', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const node = em.getNode(a.id) as HTMLElement;

        expect(node.classList.contains(SELECTED_CLASS)).toBe(false);
        sm.select(a.id);
        expect(node.classList.contains(SELECTED_CLASS)).toBe(true);
        sm.clear();
        expect(node.classList.contains(SELECTED_CLASS)).toBe(false);
    });

    it('subscribers fire on every mutation with the post-state list', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const b = em.addText({ x: 20, y: 20, text: 'B' });

        const seen: string[][] = [];
        sm.subscribe((ids) => seen.push([...ids]));

        sm.select(a.id);
        sm.addToSelection(b.id);
        sm.addToSelection(a.id); // toggle a off
        sm.clear();

        expect(seen).toEqual([
            [a.id],
            [a.id, b.id],
            [b.id],
            []
        ]);
    });

    it('subscriber returns an unsubscribe fn', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const seen: number[] = [];
        const off = sm.subscribe((ids) => seen.push(ids.length));
        sm.select(a.id);
        off();
        sm.clear();
        expect(seen).toEqual([1]);
    });

    it('select() with an unknown id clears any existing selection silently', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        sm.select(a.id);
        sm.select('el-bogus');
        expect(sm.count()).toBe(0);
    });

    it('addToSelection() ignores unknown ids', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        sm.select(a.id);
        sm.addToSelection('el-bogus');
        expect(sm.list()).toEqual([a.id]);
    });

    it('prunes selection when ElementManager.clear() drops the elements', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const b = em.addText({ x: 20, y: 20, text: 'B' });
        sm.select(a.id);
        sm.addToSelection(b.id);
        expect(sm.count()).toBe(2);

        em.clear();
        expect(sm.count()).toBe(0);
    });

    it('a misbehaving listener does not break the selection', () => {
        const { em, sm } = makeRig();
        const a = em.addText({ x: 10, y: 10, text: 'A' });
        const seen: string[] = [];
        sm.subscribe(() => {
            throw new Error('boom');
        });
        sm.subscribe((ids) => seen.push(ids.join(',')));
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        sm.select(a.id);
        errSpy.mockRestore();
        expect(seen).toEqual([a.id]);
    });
});

describe('DragDropManager (drag delta math)', () => {
    function makeDragRig() {
        document.body.innerHTML = '';
        const canvas = document.createElement('div');
        document.body.appendChild(canvas);
        const em = new ElementManager({ canvas });
        const tm = new ToolManager({ canvas, initialTool: 'select' });
        const sm = new SelectionManager({ elementManager: em });
        const dd = new DragDropManager({
            canvas,
            elementManager: em,
            selectionManager: sm,
            toolManager: tm
        });
        return { canvas, em, tm, sm, dd };
    }

    it('drag updates element.x/y by the client delta', () => {
        const { em, sm, dd } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        sm.select(a.id);

        const node = em.getNode(a.id) as HTMLElement;
        // Press on the element node at (clientX, clientY) = (200, 200).
        fireMouse(node, 'mousedown', 200, 200);
        // Move by (+15, -7).
        fireMouse(document, 'mousemove', 215, 193);
        fireMouse(document, 'mouseup', 215, 193);

        expect(a.x).toBe(115);
        expect(a.y).toBe(93);
        expect(node.style.left).toBe('115px');
        expect(node.style.top).toBe('93px');
        expect(dd.isDraggingActive()).toBe(false);
    });

    it('multi-select drag moves every selected element by the same delta', () => {
        const { em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        const b = em.addText({ x: 250, y: 50, text: 'B' });
        sm.select(a.id);
        sm.addToSelection(b.id);

        const aNode = em.getNode(a.id) as HTMLElement;
        // Press on A at (200, 200), drag to (190, 230) -> delta (-10, +30).
        fireMouse(aNode, 'mousedown', 200, 200);
        fireMouse(document, 'mousemove', 190, 230);
        fireMouse(document, 'mouseup', 190, 230);

        expect(a.x).toBe(90);
        expect(a.y).toBe(130);
        expect(b.x).toBe(240);
        expect(b.y).toBe(80);
    });

    it('mousemove without mousedown is a no-op', () => {
        const { em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        sm.select(a.id);
        fireMouse(document, 'mousemove', 999, 999);
        expect(a.x).toBe(100);
        expect(a.y).toBe(100);
    });

    it('mousedown on empty canvas clears selection but does not arm a drag', () => {
        const { canvas, em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        sm.select(a.id);
        expect(sm.count()).toBe(1);

        fireMouse(canvas, 'mousedown', 5, 5);
        expect(sm.count()).toBe(0);

        // A subsequent mousemove must not move anything.
        fireMouse(document, 'mousemove', 50, 50);
        expect(a.x).toBe(100);
        expect(a.y).toBe(100);
    });

    it('mousedown on an unselected element selects it then drags it', () => {
        const { em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });

        const node = em.getNode(a.id) as HTMLElement;
        fireMouse(node, 'mousedown', 300, 300);
        expect(sm.list()).toEqual([a.id]);

        fireMouse(document, 'mousemove', 305, 295);
        fireMouse(document, 'mouseup', 305, 295);
        expect(a.x).toBe(105);
        expect(a.y).toBe(95);
    });

    it('shift+mousedown on an unselected element ADDS it to the selection', () => {
        const { em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        const b = em.addText({ x: 200, y: 200, text: 'B' });
        sm.select(a.id);

        const bNode = em.getNode(b.id) as HTMLElement;
        fireMouse(bNode, 'mousedown', 300, 300, { shiftKey: true });
        expect(sm.list()).toEqual([a.id, b.id]);
    });

    it('shift+mousedown on an already-selected element TOGGLES it OFF and skips drag', () => {
        const { em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        const b = em.addText({ x: 200, y: 200, text: 'B' });
        sm.select(a.id);
        sm.addToSelection(b.id);

        const bNode = em.getNode(b.id) as HTMLElement;
        fireMouse(bNode, 'mousedown', 50, 50, { shiftKey: true });
        expect(sm.list()).toEqual([a.id]);

        // No drag should be armed.
        fireMouse(document, 'mousemove', 80, 80);
        expect(b.x).toBe(200);
        expect(b.y).toBe(200);
    });

    it('drag is ignored when the active tool is not select', () => {
        const { em, tm, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        sm.select(a.id);
        tm.activate('rect');

        const node = em.getNode(a.id) as HTMLElement;
        fireMouse(node, 'mousedown', 200, 200);
        fireMouse(document, 'mousemove', 250, 250);
        fireMouse(document, 'mouseup', 250, 250);

        expect(a.x).toBe(100);
        expect(a.y).toBe(100);
    });

    it('non-primary mouse buttons are ignored', () => {
        const { em, sm } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        sm.select(a.id);

        const node = em.getNode(a.id) as HTMLElement;
        fireMouse(node, 'mousedown', 200, 200, { button: 2 });
        fireMouse(document, 'mousemove', 250, 250);
        fireMouse(document, 'mouseup', 250, 250);

        expect(a.x).toBe(100);
        expect(a.y).toBe(100);
    });

    it('dispose() detaches all listeners', () => {
        const { em, sm, dd } = makeDragRig();
        const a = em.addText({ x: 100, y: 100, text: 'A' });
        sm.select(a.id);
        dd.dispose();

        const node = em.getNode(a.id) as HTMLElement;
        fireMouse(node, 'mousedown', 200, 200);
        fireMouse(document, 'mousemove', 250, 250);
        fireMouse(document, 'mouseup', 250, 250);

        expect(a.x).toBe(100);
        expect(a.y).toBe(100);
    });

    it('updateElementPosition mutates data and reflects on the node', () => {
        const { em } = makeDragRig();
        const a = em.addText({ x: 10, y: 20, text: 'A' });
        const node = em.getNode(a.id) as HTMLElement;
        updateElementPosition(a, node, 77, 88);
        expect(a.x).toBe(77);
        expect(a.y).toBe(88);
        expect(node.style.left).toBe('77px');
        expect(node.style.top).toBe('88px');
    });
});

describe('mountImageEditMode — selection wiring', () => {
    function mount() {
        document.body.innerHTML = '';
        const host = document.createElement('div');
        const canvasHost = document.createElement('div');
        document.body.appendChild(host);
        document.body.appendChild(canvasHost);
        const handle = mountImageEditMode({ host, canvasHost });
        handle.enable();
        return { host, canvasHost, handle };
    }

    it('exposes selectionInfo + deleteSelected button on the handle', () => {
        const { handle } = mount();
        expect(handle.selectionInfo).toBeTruthy();
        expect(handle.selectionInfo.id).toBe(SELECTION_INFO_ID);
        expect(handle.deleteSelectedButton).toBeTruthy();
        expect(handle.deleteSelectedButton.id).toBe(DELETE_SELECTED_ID);
        expect(handle.deleteSelectedButton.disabled).toBe(true);
        expect(handle.selectionInfo.style.display).toBe('none');
        handle.dispose();
    });

    it('selectionInfo shows "N selected" + delete button enables on selection', () => {
        const { handle } = mount();
        const a = handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        const b = handle.elementManager.addText({ x: 20, y: 20, text: 'B' });

        handle.selectionManager.select(a.id);
        expect(handle.selectionInfo.textContent).toBe('1 selected');
        expect(handle.selectionInfo.style.display).not.toBe('none');
        expect(handle.deleteSelectedButton.disabled).toBe(false);

        handle.selectionManager.addToSelection(b.id);
        expect(handle.selectionInfo.textContent).toBe('2 selected');

        handle.selectionManager.clear();
        expect(handle.selectionInfo.style.display).toBe('none');
        expect(handle.deleteSelectedButton.disabled).toBe(true);
        handle.dispose();
    });

    it('Delete key removes every selected element', () => {
        const { handle } = mount();
        const a = handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        const b = handle.elementManager.addText({ x: 20, y: 20, text: 'B' });
        const c = handle.elementManager.addText({ x: 30, y: 30, text: 'C' });

        handle.selectionManager.select(a.id);
        handle.selectionManager.addToSelection(c.id);

        const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
        document.dispatchEvent(ev);

        const remaining = handle.elementManager.list();
        expect(remaining.length).toBe(1);
        expect(remaining[0].text).toBe('B');
        // The deleted nodes are gone from the canvas.
        expect(handle.editCanvas.querySelectorAll('.iv-edit-element').length).toBe(1);
        // Selection is cleared (pruned).
        expect(handle.selectionManager.count()).toBe(0);
        // Note: prior selected element ids are NOT preserved; after a partial
        // delete, ids of survivors are reassigned (clear+rebuild path).
        handle.dispose();
    });

    it('Backspace key mirrors Delete', () => {
        const { handle } = mount();
        const a = handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        handle.selectionManager.select(a.id);

        const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
        document.dispatchEvent(ev);

        expect(handle.elementManager.count()).toBe(0);
        handle.dispose();
    });

    it('Delete key with no selection is ignored', () => {
        const { handle } = mount();
        handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        expect(handle.elementManager.count()).toBe(1);
        handle.dispose();
    });

    it('Delete key is ignored while typing in an input', () => {
        const { handle } = mount();
        const a = handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        handle.selectionManager.select(a.id);

        const input = document.createElement('input');
        document.body.appendChild(input);
        const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'target', { value: input });
        document.dispatchEvent(ev);

        // The element should NOT have been deleted.
        expect(handle.elementManager.count()).toBe(1);
        handle.dispose();
    });

    it('#deleteSelected button mirrors keyboard delete', () => {
        const { handle } = mount();
        const a = handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        const b = handle.elementManager.addText({ x: 20, y: 20, text: 'B' });
        handle.selectionManager.select(a.id);
        handle.selectionManager.addToSelection(b.id);

        handle.deleteSelectedButton.click();
        expect(handle.elementManager.count()).toBe(0);
        handle.dispose();
    });

    it('onSelectionChange option fires on every selection mutation', () => {
        document.body.innerHTML = '';
        const host = document.createElement('div');
        document.body.appendChild(host);
        const seen: string[][] = [];
        const handle = mountImageEditMode({
            host,
            onSelectionChange: (ids) => seen.push([...ids])
        });
        handle.enable();

        const a = handle.elementManager.addText({ x: 10, y: 10, text: 'A' });
        handle.selectionManager.select(a.id);
        handle.selectionManager.clear();

        expect(seen).toEqual([
            [a.id],
            []
        ]);
        handle.dispose();
    });

    it('drag through mountImageEditMode updates element coordinates end-to-end', () => {
        const { handle } = mount();
        const a = handle.elementManager.addText({ x: 100, y: 100, text: 'A' });
        handle.selectionManager.select(a.id);

        const node = handle.elementManager.getNode(a.id) as HTMLElement;
        fireMouse(node, 'mousedown', 200, 200);
        fireMouse(document, 'mousemove', 220, 180);
        fireMouse(document, 'mouseup', 220, 180);

        expect(a.x).toBe(120);
        expect(a.y).toBe(80);
        handle.dispose();
    });
});
