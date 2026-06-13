// Unit tests for the PSD single-layer view modal (issue #52).
//
// Coverage:
//   - `clickIsOnOverlay` returns `true` only when the click target IS
//     the overlay element itself (backdrop click), not when it's a
//     descendant — that's the contract that prevents an accidental
//     close when the user clicks on the canvas / header.
//   - `openLayerView` mounts a modal node into the host with the
//     expected class names + a checkerboard wrapper.
//   - The modal closes on:
//       * an explicit `dispose()` call,
//       * a click on the overlay backdrop,
//       * the ESC key.
//   - `dispose()` is idempotent and the `onClose` callback fires
//     exactly once.
//
// We intentionally only assert on DOM structure + close flow. The
// pixel-copy step (`drawImage(sourceCanvas, 0, 0)`) is exercised by
// jsdom but it ships a no-op 2D context, so we just check that the
// target canvas exists and has the right dimensions.

import {
    clickIsOnOverlay,
    openLayerView
} from '../templates/psd/js/psdViewModal';

/**
 * Build a canvas-shaped object with `width` / `height` getters.
 * jsdom ships a real `HTMLCanvasElement` but its `getContext('2d')`
 * returns a stubbed 2D context that won't throw on `drawImage` — so
 * we use a real canvas and just don't assert on pixel content.
 */
const makeSourceCanvas = (w: number, h: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
};

describe('clickIsOnOverlay', () => {
    it('returns true when the click target is the overlay itself', () => {
        const overlay = document.createElement('div');
        const event = new MouseEvent('click', { bubbles: true });
        // Force the target via Object.defineProperty since `.target`
        // is read-only on synthetic events otherwise.
        Object.defineProperty(event, 'target', { value: overlay });
        expect(clickIsOnOverlay(event, overlay)).toBe(true);
    });

    it('returns false when the click target is a descendant of the overlay', () => {
        const overlay = document.createElement('div');
        const child = document.createElement('div');
        overlay.appendChild(child);
        const event = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(event, 'target', { value: child });
        expect(clickIsOnOverlay(event, overlay)).toBe(false);
    });

    it('returns false when the click target is an unrelated element', () => {
        const overlay = document.createElement('div');
        const other = document.createElement('div');
        const event = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(event, 'target', { value: other });
        expect(clickIsOnOverlay(event, overlay)).toBe(false);
    });

    it('returns false when the event has no target', () => {
        const overlay = document.createElement('div');
        const event = new MouseEvent('click');
        // No target override — jsdom defaults to `null`.
        expect(clickIsOnOverlay(event, overlay)).toBe(false);
    });
});

describe('openLayerView', () => {
    let host: HTMLElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        // Defensive: rip any leftover modals out of the document so a
        // failing assertion in one test doesn't leak DOM state into
        // the next one.
        document.querySelectorAll('.psd-modal').forEach((el) => el.remove());
        if (host.parentNode) host.parentNode.removeChild(host);
    });

    it('mounts a modal with the expected class hooks into the host', () => {
        const src = makeSourceCanvas(64, 32);
        const handle = openLayerView(src, 'Layer A', { host });

        const overlay = host.querySelector('.psd-modal');
        expect(overlay).not.toBeNull();
        expect(overlay).toBe(handle.root);
        expect(overlay?.querySelector('.psd-modal-content')).not.toBeNull();
        expect(overlay?.querySelector('.psd-modal-header')).not.toBeNull();
        expect(overlay?.querySelector('.psd-modal-title')?.textContent).toBe('Layer A');
        expect(overlay?.querySelector('.psd-modal-close')).not.toBeNull();
        expect(overlay?.querySelector('.psd-checkerboard')).not.toBeNull();
        const canvas = overlay?.querySelector<HTMLCanvasElement>('.psd-modal-canvas');
        expect(canvas).not.toBeNull();
        expect(canvas?.width).toBe(64);
        expect(canvas?.height).toBe(32);

        handle.dispose();
    });

    it('falls back to "Layer" when no name is given', () => {
        const src = makeSourceCanvas(8, 8);
        const handle = openLayerView(src, undefined, { host });
        expect(handle.root.querySelector('.psd-modal-title')?.textContent).toBe('Layer');
        handle.dispose();
    });

    it('falls back to "Layer" when the name is whitespace-only', () => {
        const src = makeSourceCanvas(8, 8);
        const handle = openLayerView(src, '   ', { host });
        expect(handle.root.querySelector('.psd-modal-title')?.textContent).toBe('Layer');
        handle.dispose();
    });

    it('clamps zero / negative canvas dimensions to 1px (defensive)', () => {
        // A 0x0 source canvas would otherwise crash some `drawImage`
        // implementations; the modal clamps to 1x1 so the surface
        // still mounts.
        const src = makeSourceCanvas(0, 0);
        const handle = openLayerView(src, 'Empty', { host });
        const canvas = handle.root.querySelector<HTMLCanvasElement>('.psd-modal-canvas');
        expect(canvas?.width).toBe(1);
        expect(canvas?.height).toBe(1);
        handle.dispose();
    });

    it('removes the modal from the DOM on dispose() and reports isDisposed', () => {
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host });
        expect(host.querySelector('.psd-modal')).not.toBeNull();
        expect(handle.isDisposed()).toBe(false);

        handle.dispose();

        expect(host.querySelector('.psd-modal')).toBeNull();
        expect(handle.isDisposed()).toBe(true);
    });

    it('is idempotent: dispose() can be called multiple times safely', () => {
        const onClose = jest.fn();
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host, onClose });

        handle.dispose();
        handle.dispose();
        handle.dispose();

        expect(handle.isDisposed()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on a click on the overlay backdrop', () => {
        const onClose = jest.fn();
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host, onClose });
        const overlay = handle.root;

        // Synthesize a click whose `target` is the overlay itself.
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'target', { value: overlay });
        overlay.dispatchEvent(event);

        expect(handle.isDisposed()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(host.querySelector('.psd-modal')).toBeNull();
    });

    it('does NOT close when the click lands on the modal content', () => {
        const onClose = jest.fn();
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host, onClose });
        const content = handle.root.querySelector<HTMLElement>('.psd-modal-content');
        expect(content).not.toBeNull();

        // A real click on .psd-modal-content bubbles up to the overlay
        // listener, but our handler ignores it because the target is
        // not the overlay element itself.
        content!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(handle.isDisposed()).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        handle.dispose();
    });

    it('closes on the explicit close button click', () => {
        const onClose = jest.fn();
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host, onClose });
        const closeBtn = handle.root.querySelector<HTMLElement>('.psd-modal-close');
        expect(closeBtn).not.toBeNull();

        closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(handle.isDisposed()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the ESC key is pressed', () => {
        const onClose = jest.fn();
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host, onClose });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(handle.isDisposed()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT close on unrelated keys', () => {
        const onClose = jest.fn();
        const src = makeSourceCanvas(16, 16);
        const handle = openLayerView(src, 'L', { host, onClose });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

        expect(handle.isDisposed()).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        handle.dispose();
    });

    it('uses document.body as the default host when no host is provided', () => {
        const src = makeSourceCanvas(8, 8);
        const handle = openLayerView(src, 'L');
        expect(document.body.contains(handle.root)).toBe(true);
        handle.dispose();
        expect(document.body.contains(handle.root)).toBe(false);
    });

    it('survives an onClose callback that throws (cleanup still completes)', () => {
        const src = makeSourceCanvas(8, 8);
        const handle = openLayerView(src, 'L', {
            host,
            onClose: () => {
                throw new Error('boom');
            }
        });

        // Should NOT propagate the throw out of dispose().
        expect(() => handle.dispose()).not.toThrow();
        expect(handle.isDisposed()).toBe(true);
        expect(host.querySelector('.psd-modal')).toBeNull();
    });

    it('removes the keydown listener after dispose so ESC has no further effect', () => {
        const src = makeSourceCanvas(8, 8);
        const handleA = openLayerView(src, 'A', { host });
        handleA.dispose();

        // Open a second modal; pressing ESC should close ONLY the
        // second modal, proving that the first modal's listener
        // was removed during its own dispose.
        const handleB = openLayerView(src, 'B', { host });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(handleB.isDisposed()).toBe(true);
    });
});
