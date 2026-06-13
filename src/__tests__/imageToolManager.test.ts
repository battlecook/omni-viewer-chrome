/**
 * Unit tests for the issue #11 ToolManager + ImageEditMode skeleton.
 *
 * Covered DoD items:
 *   - initial tool = 'select'
 *   - activate cycles through every sticky tool + delete
 *   - subscribers fire on every activation
 *   - registered button gets `is-active` class for the current tool
 *   - canvas gains the per-tool cursor class
 *   - mountImageEditMode panel show/hide via toggle()
 *   - ESC handler returns to 'select' while edit mode is enabled
 */

import {
    ToolManager,
    ToolName,
    ALL_TOOLS,
    STICKY_TOOLS,
    TOOL_CURSOR_CLASS,
    isToolName
} from '../templates/image/js/ImageEditMode/managers/ToolManager';
import { mountImageEditMode } from '../templates/image/js/ImageEditMode';

describe('ToolManager', () => {
    it('starts with select as the active tool', () => {
        const tm = new ToolManager();
        expect(tm.getActive()).toBe('select');
    });

    it('honors `initialTool`', () => {
        const tm = new ToolManager({ initialTool: 'circle' });
        expect(tm.getActive()).toBe('circle');
    });

    it('activate() switches the sticky tool', () => {
        const tm = new ToolManager();
        for (const tool of STICKY_TOOLS) {
            tm.activate(tool);
            expect(tm.getActive()).toBe(tool);
        }
    });

    it('activate("delete") fires listeners but does NOT replace the sticky tool', () => {
        const tm = new ToolManager();
        tm.activate('rect');
        tm.activate('delete');
        expect(tm.getActive()).toBe('rect');
    });

    it('ignores unknown tool names', () => {
        const tm = new ToolManager();
        tm.activate('bogus' as unknown as ToolName);
        expect(tm.getActive()).toBe('select');
    });

    it('subscribe() listener fires on every activation including delete', () => {
        const tm = new ToolManager();
        const seen: ToolName[] = [];
        tm.subscribe((t) => seen.push(t));

        tm.activate('text');
        tm.activate('circle');
        tm.activate('delete');
        tm.activate('select');

        expect(seen).toEqual(['text', 'circle', 'delete', 'select']);
    });

    it('subscribe() returns an unsubscribe fn', () => {
        const tm = new ToolManager();
        const seen: ToolName[] = [];
        const unsubscribe = tm.subscribe((t) => seen.push(t));
        tm.activate('text');
        unsubscribe();
        tm.activate('circle');
        expect(seen).toEqual(['text']);
    });

    it('a misbehaving listener does not break the activation', () => {
        const tm = new ToolManager();
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        tm.subscribe(() => {
            throw new Error('boom');
        });
        const goodSeen: ToolName[] = [];
        tm.subscribe((t) => goodSeen.push(t));
        tm.activate('rect');
        expect(tm.getActive()).toBe('rect');
        expect(goodSeen).toEqual(['rect']);
        errSpy.mockRestore();
    });

    it('registered buttons receive `is-active` for their tool', () => {
        const tm = new ToolManager();
        const buttons: Record<ToolName, HTMLButtonElement> = {
            select: document.createElement('button'),
            text: document.createElement('button'),
            circle: document.createElement('button'),
            rect: document.createElement('button'),
            delete: document.createElement('button')
        };
        for (const tool of ALL_TOOLS) {
            tm.registerButton(tool, buttons[tool]);
        }

        // Initial: select button is active.
        expect(buttons.select.classList.contains('is-active')).toBe(true);
        expect(buttons.text.classList.contains('is-active')).toBe(false);

        tm.activate('text');
        expect(buttons.select.classList.contains('is-active')).toBe(false);
        expect(buttons.text.classList.contains('is-active')).toBe(true);

        tm.activate('rect');
        expect(buttons.text.classList.contains('is-active')).toBe(false);
        expect(buttons.rect.classList.contains('is-active')).toBe(true);

        // Delete must never get is-active (transient).
        tm.activate('delete');
        expect(buttons.delete.classList.contains('is-active')).toBe(false);
        // Sticky tool didn't change.
        expect(buttons.rect.classList.contains('is-active')).toBe(true);
    });

    it('clicking a registered button activates that tool', () => {
        const tm = new ToolManager();
        const btn = document.createElement('button');
        tm.registerButton('circle', btn);
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(tm.getActive()).toBe('circle');
    });

    it('canvas receives the per-tool cursor class + select-mode class', () => {
        const canvas = document.createElement('div');
        const tm = new ToolManager({ canvas });

        tm.activate('select');
        expect(canvas.classList.contains(TOOL_CURSOR_CLASS.select)).toBe(true);
        expect(canvas.classList.contains('select-mode')).toBe(true);

        tm.activate('text');
        expect(canvas.classList.contains(TOOL_CURSOR_CLASS.text)).toBe(true);
        expect(canvas.classList.contains(TOOL_CURSOR_CLASS.select)).toBe(false);
        expect(canvas.classList.contains('select-mode')).toBe(false);

        tm.activate('rect');
        expect(canvas.classList.contains(TOOL_CURSOR_CLASS.rect)).toBe(true);

        // delete clears the cursor classes.
        tm.activate('delete');
        // sticky tool was rect, so rect cursor still on canvas after delete.
        expect(canvas.classList.contains(TOOL_CURSOR_CLASS.rect)).toBe(true);
    });

    it('resetToSelect() returns to select', () => {
        const tm = new ToolManager();
        tm.activate('text');
        tm.resetToSelect();
        expect(tm.getActive()).toBe('select');
    });

    it('isToolName narrows correctly', () => {
        expect(isToolName('select')).toBe(true);
        expect(isToolName('text')).toBe(true);
        expect(isToolName('circle')).toBe(true);
        expect(isToolName('rect')).toBe(true);
        expect(isToolName('delete')).toBe(true);
        expect(isToolName('rectangle')).toBe(false);
        expect(isToolName(undefined)).toBe(false);
        expect(isToolName(42)).toBe(false);
    });
});

describe('mountImageEditMode', () => {
    let host: HTMLElement;

    beforeEach(() => {
        document.body.innerHTML = '';
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    it('mounts a hidden panel with one button per tool', () => {
        const handle = mountImageEditMode({ host });
        const panel = host.querySelector('.iv-edit-controls') as HTMLElement;
        expect(panel).toBeTruthy();
        expect(panel.style.display).toBe('none');

        const buttons = panel.querySelectorAll('.iv-edit-btn');
        expect(buttons.length).toBe(ALL_TOOLS.length);

        handle.dispose();
    });

    it('toggle() shows/hides the panel and reports state', () => {
        const onToggle = jest.fn();
        const handle = mountImageEditMode({ host, onToggle });
        const panel = host.querySelector('.iv-edit-controls') as HTMLElement;

        expect(handle.isEnabled()).toBe(false);

        const enabled1 = handle.toggle();
        expect(enabled1).toBe(true);
        expect(handle.isEnabled()).toBe(true);
        expect(panel.style.display).toBe('');
        expect(onToggle).toHaveBeenLastCalledWith(true);

        const enabled2 = handle.toggle();
        expect(enabled2).toBe(false);
        expect(panel.style.display).toBe('none');
        expect(onToggle).toHaveBeenLastCalledWith(false);

        handle.dispose();
    });

    it('ESC inside edit mode resets the active tool to select', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();
        handle.toolManager.activate('rect');
        expect(handle.toolManager.getActive()).toBe('rect');

        const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(escEvent);

        expect(handle.toolManager.getActive()).toBe('select');
        handle.dispose();
    });

    it('ESC is ignored when edit mode is disabled', () => {
        const handle = mountImageEditMode({ host });
        // Force an off-default tool while still disabled — exercises the
        // guard inside `onKeyDown`.
        handle.toolManager.activate('text');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(handle.toolManager.getActive()).toBe('text');
        handle.dispose();
    });

    it('ESC is ignored when the focus is in an input', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();
        handle.toolManager.activate('rect');

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();

        // We have to dispatch on the input so the event target is the input.
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(handle.toolManager.getActive()).toBe('rect');
        handle.dispose();
    });

    it('disable() resets to select and detaches the ESC handler', () => {
        const handle = mountImageEditMode({ host });
        handle.enable();
        handle.toolManager.activate('rect');
        handle.disable();

        expect(handle.toolManager.getActive()).toBe('select');

        // Switching to a non-select tool while disabled should not be
        // reverted by ESC anymore.
        handle.toolManager.activate('text');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(handle.toolManager.getActive()).toBe('text');
        handle.dispose();
    });

    it('dispose() removes the panel from the host', () => {
        const handle = mountImageEditMode({ host });
        expect(host.querySelector('.iv-edit-controls')).toBeTruthy();
        handle.dispose();
        expect(host.querySelector('.iv-edit-controls')).toBeNull();
    });

    it('onToolActivate fires for every tool activation', () => {
        const onToolActivate = jest.fn();
        const handle = mountImageEditMode({ host, onToolActivate });
        handle.enable();
        // enable() already fires `select`. Capture call count and continue.
        const baseline = onToolActivate.mock.calls.length;

        handle.toolManager.activate('text');
        handle.toolManager.activate('delete');

        const calls = onToolActivate.mock.calls.slice(baseline).map((args) => args[0]);
        expect(calls).toEqual(['text', 'delete']);
        handle.dispose();
    });
});
