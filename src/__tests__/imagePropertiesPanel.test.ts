/**
 * Unit tests for issue #14 PropertiesPanel — pure binding reducers +
 * DOM-driven two-way binding through the ElementManager.
 *
 * Covered DoD items:
 *   - selection -> input population (computeBoundProperties).
 *   - input edit -> partial update (applyPropertyChange).
 *   - End-to-end binding: select element, edit input, ElementManager mutates.
 *   - Panel hidden when selection is empty / > 1 / unknown id.
 *   - Per-row visibility: text rows hide for shapes, border rows hide for text.
 */

import {
    computeBoundProperties,
    computeRowVisibility,
    applyPropertyChange,
    mountPropertiesPanel,
    DEFAULT_FILL,
    DEFAULT_STROKE,
    DEFAULT_OPACITY_PCT,
    DEFAULT_FONT_SIZE
} from '../templates/image/js/ImageEditMode/managers/PropertiesPanel';
import { ElementManager } from '../templates/image/js/ImageEditMode/managers/ElementManager';
import { SelectionManager } from '../templates/image/js/ImageEditMode/managers/SelectionManager';

describe('computeBoundProperties (selection -> panel reducer)', () => {
    it('reads style fields verbatim for a fully-specified shape', () => {
        const props = computeBoundProperties({
            id: 'el-1',
            type: 'rect',
            x: 0, y: 0, w: 10, h: 10,
            style: { fill: '#abcdef', stroke: '#123456', strokeWidth: 2, opacity: 0.5 }
        });
        expect(props.shapeColor).toBe('#abcdef');
        expect(props.borderColor).toBe('#123456');
        expect(props.fillOpacity).toBe(50);
        expect(props.borderOpacity).toBe(50);
        expect(props.fontSize).toBe(DEFAULT_FONT_SIZE);
    });

    it('uses defaults when style fields are missing', () => {
        const props = computeBoundProperties({
            id: 'el-1',
            type: 'rect',
            x: 0, y: 0, w: 10, h: 10,
            style: {}
        });
        expect(props.shapeColor).toBe(DEFAULT_FILL);
        expect(props.borderColor).toBe(DEFAULT_STROKE);
        expect(props.fillOpacity).toBe(DEFAULT_OPACITY_PCT);
    });

    it('reads text + fontSize for text elements', () => {
        const props = computeBoundProperties({
            id: 'el-1',
            type: 'text',
            x: 0, y: 0, w: 50, h: 30,
            text: 'hello',
            style: { fill: '#ff0000', fontSize: 32, opacity: 1 }
        });
        expect(props.text).toBe('hello');
        expect(props.fontSize).toBe(32);
        expect(props.shapeColor).toBe('#ff0000');
        expect(props.fillOpacity).toBe(100);
    });

    it('rounds opacity 0..1 to 0..100 percent', () => {
        const props = computeBoundProperties({
            id: 'el-1',
            type: 'rect',
            x: 0, y: 0, w: 10, h: 10,
            style: { opacity: 0.234 }
        });
        expect(props.fillOpacity).toBe(23);
    });
});

describe('computeRowVisibility', () => {
    it('hides border + text rows for text elements... wait, hides text rows for shapes', () => {
        const shape = computeRowVisibility({
            id: 'el-1', type: 'rect', x: 0, y: 0, w: 10, h: 10, style: {}
        });
        expect(shape).toEqual({
            shapeColor: true,
            borderColor: true,
            fillOpacity: true,
            borderOpacity: true,
            text: false,
            fontSize: false
        });

        const text = computeRowVisibility({
            id: 'el-1', type: 'text', x: 0, y: 0, w: 10, h: 10, text: '', style: {}
        });
        expect(text).toEqual({
            shapeColor: true,
            borderColor: false,
            fillOpacity: true,
            borderOpacity: false,
            text: true,
            fontSize: true
        });
    });
});

describe('applyPropertyChange (input -> partial update reducer)', () => {
    const shape = {
        id: 'el-1', type: 'rect' as const, x: 0, y: 0, w: 10, h: 10, style: {}
    };
    const text = {
        id: 'el-2', type: 'text' as const, x: 0, y: 0, w: 50, h: 30, text: 'hi', style: {}
    };

    it('shapeColor -> { style: { fill } }', () => {
        expect(applyPropertyChange(shape, 'shapeColor', '#aabbcc')).toEqual({ style: { fill: '#aabbcc' } });
    });

    it('rejects non-hex shapeColor', () => {
        expect(applyPropertyChange(shape, 'shapeColor', 'red')).toBeNull();
        expect(applyPropertyChange(shape, 'shapeColor', '#abc')).toBeNull();
    });

    it('borderColor only valid for shapes', () => {
        expect(applyPropertyChange(shape, 'borderColor', '#123456')).toEqual({ style: { stroke: '#123456' } });
        expect(applyPropertyChange(text, 'borderColor', '#123456')).toBeNull();
    });

    it('opacity converts percent to 0..1 and clamps', () => {
        expect(applyPropertyChange(shape, 'fillOpacity', '50')).toEqual({ style: { opacity: 0.5 } });
        expect(applyPropertyChange(shape, 'fillOpacity', '200')).toEqual({ style: { opacity: 1 } });
        expect(applyPropertyChange(shape, 'fillOpacity', '-5')).toEqual({ style: { opacity: 0 } });
        expect(applyPropertyChange(shape, 'fillOpacity', 'nope')).toBeNull();
    });

    it('text only valid for text elements', () => {
        expect(applyPropertyChange(text, 'text', 'world')).toEqual({ text: 'world' });
        expect(applyPropertyChange(shape, 'text', 'world')).toBeNull();
    });

    it('fontSize only valid for text elements + positive ints', () => {
        expect(applyPropertyChange(text, 'fontSize', '36')).toEqual({ style: { fontSize: 36 } });
        expect(applyPropertyChange(text, 'fontSize', '0')).toBeNull();
        expect(applyPropertyChange(text, 'fontSize', '-2')).toBeNull();
        expect(applyPropertyChange(text, 'fontSize', 'abc')).toBeNull();
        expect(applyPropertyChange(shape, 'fontSize', '36')).toBeNull();
    });
});

describe('mountPropertiesPanel (DOM-backed two-way binding)', () => {
    let host: HTMLElement;
    let canvas: HTMLElement;
    let em: ElementManager;
    let sm: SelectionManager;

    beforeEach(() => {
        document.body.innerHTML = '';
        host = document.createElement('div');
        canvas = document.createElement('div');
        document.body.appendChild(host);
        document.body.appendChild(canvas);
        em = new ElementManager({ canvas });
        sm = new SelectionManager({ elementManager: em });
    });

    it('panel is hidden when selection is empty', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        expect(handle.panel.style.display).toBe('none');
        handle.dispose();
    });

    it('panel is hidden when selection size > 1', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const a = em.addRectangle({ x: 0, y: 0 });
        const b = em.addRectangle({ x: 50, y: 50 });
        sm.select(a.id);
        sm.addToSelection(b.id);
        expect(handle.panel.style.display).toBe('none');
        handle.dispose();
    });

    it('populates inputs from the selected element on selection change', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const a = em.addCircle({
            x: 0, y: 0, w: 60, h: 60,
            fill: '#112233', stroke: '#445566', opacity: 0.4
        });
        sm.select(a.id);

        expect(handle.panel.style.display).not.toBe('none');
        expect(handle.inputs.shapeColor.value).toBe('#112233');
        expect(handle.inputs.borderColor.value).toBe('#445566');
        expect(handle.inputs.fillOpacity.value).toBe('40');
        handle.dispose();
    });

    it('shows text-only rows for text elements and hides border rows', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const t = em.addText({ x: 0, y: 0, text: 'hello', fontSize: 30, color: '#ff00ff', opacity: 0.9 });
        sm.select(t.id);

        expect(handle.inputs.text.value).toBe('hello');
        expect(handle.inputs.fontSize.value).toBe('30');
        expect(handle.inputs.shapeColor.value).toBe('#ff00ff');
        expect(handle.inputs.borderColor.parentElement!.style.display).toBe('none');
        expect(handle.inputs.borderOpacity.parentElement!.style.display).toBe('none');
        expect(handle.inputs.text.parentElement!.style.display).not.toBe('none');
        expect(handle.inputs.fontSize.parentElement!.style.display).not.toBe('none');
        handle.dispose();
    });

    it('panel -> element: editing shapeColor updates element style', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const a = em.addRectangle({ x: 0, y: 0, w: 50, h: 50 });
        sm.select(a.id);

        handle.inputs.shapeColor.value = '#00ff00';
        handle.inputs.shapeColor.dispatchEvent(new Event('input', { bubbles: true }));

        expect(em.getById(a.id)!.style.fill).toBe('#00ff00');
        handle.dispose();
    });

    it('panel -> element: editing fillOpacity updates element opacity (percent -> 0..1)', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const a = em.addRectangle({ x: 0, y: 0, w: 50, h: 50, opacity: 1 });
        sm.select(a.id);

        handle.inputs.fillOpacity.value = '25';
        handle.inputs.fillOpacity.dispatchEvent(new Event('input', { bubbles: true }));

        expect(em.getById(a.id)!.style.opacity).toBe(0.25);
        handle.dispose();
    });

    it('panel -> element: editing text changes element.text + DOM textContent', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const t = em.addText({ x: 0, y: 0, text: 'before' });
        sm.select(t.id);

        handle.inputs.text.value = 'after';
        handle.inputs.text.dispatchEvent(new Event('input', { bubbles: true }));

        expect(em.getById(t.id)!.text).toBe('after');
        expect(em.getNode(t.id)!.textContent).toBe('after');
        handle.dispose();
    });

    it('panel -> element: editing fontSize via slider mirrors to numeric input', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const t = em.addText({ x: 0, y: 0, text: 'hi', fontSize: 24 });
        sm.select(t.id);

        handle.inputs.fontSize.value = '48';
        handle.inputs.fontSize.dispatchEvent(new Event('input', { bubbles: true }));

        expect(em.getById(t.id)!.style.fontSize).toBe(48);
        expect(handle.inputs.fontSizeInput.value).toBe('48');
        handle.dispose();
    });

    it('hides the panel when the selected element is removed', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const a = em.addRectangle({ x: 0, y: 0 });
        sm.select(a.id);
        expect(handle.panel.style.display).not.toBe('none');
        em.clear();
        expect(handle.panel.style.display).toBe('none');
        handle.dispose();
    });

    it('dispose detaches listeners + removes the panel from the host', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        expect(host.contains(handle.panel)).toBe(true);
        handle.dispose();
        expect(host.contains(handle.panel)).toBe(false);

        // Subsequent selection changes should not throw or mutate the DOM.
        const a = em.addRectangle({ x: 0, y: 0 });
        sm.select(a.id);
        expect(host.contains(handle.panel)).toBe(false);
    });

    it('refresh() pulls latest values without an external selection event', () => {
        const handle = mountPropertiesPanel({ elementManager: em, selectionManager: sm, host });
        const a = em.addRectangle({ x: 0, y: 0, fill: '#aaaaaa' });
        sm.select(a.id);
        expect(handle.inputs.shapeColor.value).toBe('#aaaaaa');
        // Mutate the element directly (bypassing the panel) and confirm
        // refresh picks it up.
        em.update(a.id, { style: { fill: '#bbbbbb' } });
        // ElementManager emits change events on update — refresh ran already,
        // but call it explicitly to validate the public API.
        handle.refresh();
        expect(handle.inputs.shapeColor.value).toBe('#bbbbbb');
        handle.dispose();
    });
});
