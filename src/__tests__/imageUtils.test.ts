// Unit tests for `src/templates/image/js/imageUtils.ts`.
//
// Per issue #9 DoD, the focus is transform accumulation:
//   rotate + flip + scale -> expected CSS transform string.
//
// We also cover fit-to-screen math, format derivation from File metadata,
// and human-readable file size formatting since those are the other
// contracts the orchestration layer depends on.

import {
    createIdentityTransform,
    rotate,
    flipHorizontal,
    flipVertical,
    zoomIn,
    zoomOut,
    setScale,
    clampScale,
    transformToCss,
    computeFitToScreenScale,
    getImageFormatFromFile,
    formatFileSize,
    ZOOM_MIN,
    ZOOM_MAX
} from '../templates/image/js/imageUtils';

describe('imageUtils — identity', () => {
    it('createIdentityTransform returns 0deg / 1x / 1x / 1', () => {
        expect(createIdentityTransform()).toEqual({
            rotateDeg: 0,
            scaleX: 1,
            scaleY: 1,
            scale: 1
        });
    });

    it('transformToCss serializes identity to scale(1, 1) rotate(0deg)', () => {
        const t = createIdentityTransform();
        expect(transformToCss(t)).toBe('scale(1, 1) rotate(0deg)');
    });
});

describe('imageUtils — rotate', () => {
    it('rotates by +90 each click and wraps at 360', () => {
        let t = createIdentityTransform();
        t = rotate(t);
        expect(t.rotateDeg).toBe(90);
        t = rotate(t);
        expect(t.rotateDeg).toBe(180);
        t = rotate(t);
        expect(t.rotateDeg).toBe(270);
        t = rotate(t);
        expect(t.rotateDeg).toBe(0);
    });

    it('rotate(-90) wraps negative deltas to [0, 360)', () => {
        const t = rotate(createIdentityTransform(), -90);
        expect(t.rotateDeg).toBe(270);
    });

    it('CSS transform string includes the rotation', () => {
        const t = rotate(createIdentityTransform()); // 90deg
        expect(transformToCss(t)).toBe('scale(1, 1) rotate(90deg)');
    });
});

describe('imageUtils — flip', () => {
    it('flipHorizontal toggles scaleX', () => {
        let t = createIdentityTransform();
        t = flipHorizontal(t);
        expect(t.scaleX).toBe(-1);
        expect(t.scaleY).toBe(1);
        t = flipHorizontal(t);
        expect(t.scaleX).toBe(1);
    });

    it('flipVertical toggles scaleY', () => {
        let t = createIdentityTransform();
        t = flipVertical(t);
        expect(t.scaleY).toBe(-1);
        expect(t.scaleX).toBe(1);
    });

    it('flipping does not modify rotation or scale', () => {
        const base = setScale(rotate(createIdentityTransform()), 2);
        const flipped = flipHorizontal(base);
        expect(flipped.rotateDeg).toBe(90);
        expect(flipped.scale).toBe(2);
    });

    it('flips compose into the CSS scale axes', () => {
        let t = createIdentityTransform();
        t = flipHorizontal(t);
        expect(transformToCss(t)).toBe('scale(-1, 1) rotate(0deg)');
        t = flipVertical(t);
        expect(transformToCss(t)).toBe('scale(-1, -1) rotate(0deg)');
    });
});

describe('imageUtils — zoom', () => {
    it('zoomIn increments scale by 0.25 (default step)', () => {
        const t = zoomIn(createIdentityTransform());
        expect(t.scale).toBeCloseTo(1.25, 5);
    });

    it('zoomOut decrements scale by 0.25', () => {
        const t = zoomOut(createIdentityTransform());
        expect(t.scale).toBeCloseTo(0.75, 5);
    });

    it('clampScale enforces the [ZOOM_MIN, ZOOM_MAX] band', () => {
        expect(clampScale(0)).toBe(ZOOM_MIN);
        expect(clampScale(100)).toBe(ZOOM_MAX);
        expect(clampScale(2)).toBe(2);
        expect(clampScale(Number.NaN)).toBe(1);
    });

    it('repeated zoomIn saturates at ZOOM_MAX', () => {
        let t = createIdentityTransform();
        for (let i = 0; i < 50; i++) t = zoomIn(t);
        expect(t.scale).toBe(ZOOM_MAX);
    });

    it('repeated zoomOut saturates at ZOOM_MIN', () => {
        let t = createIdentityTransform();
        for (let i = 0; i < 50; i++) t = zoomOut(t);
        expect(t.scale).toBe(ZOOM_MIN);
    });

    it('setScale clamps explicit values', () => {
        expect(setScale(createIdentityTransform(), 999).scale).toBe(ZOOM_MAX);
        expect(setScale(createIdentityTransform(), -5).scale).toBe(ZOOM_MIN);
    });
});

describe('imageUtils — combined transforms (DoD coverage)', () => {
    it('rotate + flipHorizontal + scale composes correctly in CSS', () => {
        let t = createIdentityTransform();
        t = rotate(t);                  // +90deg
        t = flipHorizontal(t);          // scaleX = -1
        t = setScale(t, 2);             // scale = 2
        // CSS form: scale(scale*scaleX, scale*scaleY) rotate(deg)
        // -> scale(-2, 2) rotate(90deg)
        expect(transformToCss(t)).toBe('scale(-2, 2) rotate(90deg)');
    });

    it('rotate + flipVertical + zoomOut composes correctly', () => {
        let t = createIdentityTransform();
        t = rotate(t);                  // 90deg
        t = rotate(t);                  // 180deg
        t = flipVertical(t);            // scaleY = -1
        t = zoomOut(t);                 // scale = 0.75
        const css = transformToCss(t);
        expect(css).toBe('scale(0.75, -0.75) rotate(180deg)');
    });

    it('flipHorizontal + flipVertical + scale 0.5 -> scale(-0.5, -0.5) rotate(0deg)', () => {
        let t = createIdentityTransform();
        t = flipHorizontal(t);
        t = flipVertical(t);
        t = setScale(t, 0.5);
        expect(transformToCss(t)).toBe('scale(-0.5, -0.5) rotate(0deg)');
    });

    it('reset (identity) cancels prior transforms', () => {
        let t = createIdentityTransform();
        t = rotate(t);
        t = flipHorizontal(t);
        t = setScale(t, 3);
        // simulate "reset" — caller replaces with identity
        t = createIdentityTransform();
        expect(transformToCss(t)).toBe('scale(1, 1) rotate(0deg)');
    });
});

describe('imageUtils — computeFitToScreenScale', () => {
    it('shrinks to fit a wide image', () => {
        const scale = computeFitToScreenScale(540, 540, 1000, 500);
        // (540-40) / 1000 = 0.5, (540-40) / 500 = 1, capped at 1
        expect(scale).toBeCloseTo(0.5, 5);
    });

    it('does not upscale when the image fits', () => {
        const scale = computeFitToScreenScale(2000, 2000, 100, 100);
        // both ratios are huge, but capped at 1 (allowUpscale=false)
        expect(scale).toBe(1);
    });

    it('honors allowUpscale=true', () => {
        const scale = computeFitToScreenScale(2000, 2000, 100, 100, { allowUpscale: true });
        expect(scale).toBeCloseTo(ZOOM_MAX, 5); // clamped at ZOOM_MAX (5)
    });

    it('returns 1 for degenerate (zero-size) images', () => {
        expect(computeFitToScreenScale(800, 600, 0, 0)).toBe(1);
    });

    it('honors a custom padding value', () => {
        const a = computeFitToScreenScale(540, 540, 1000, 500, { padding: 0 });
        // (540) / 1000 = 0.54, (540) / 500 = 1.08, min = 0.54, capped at 1
        expect(a).toBeCloseTo(0.54, 5);
    });
});

describe('imageUtils — getImageFormatFromFile', () => {
    it('uses the MIME subtype when present', () => {
        expect(getImageFormatFromFile({ name: 'pic.png', type: 'image/png' })).toBe('PNG');
        expect(getImageFormatFromFile({ name: 'pic.jpg', type: 'image/jpeg' })).toBe('JPEG');
    });

    it('strips x- vendor prefixes', () => {
        expect(getImageFormatFromFile({ name: 'pic.bmp', type: 'image/x-bmp' })).toBe('BMP');
    });

    it('falls back to extension when MIME is missing', () => {
        expect(getImageFormatFromFile({ name: 'pic.GIF', type: '' })).toBe('GIF');
        expect(getImageFormatFromFile({ name: 'pic.webp' })).toBe('WEBP');
    });

    it('returns empty string when neither source is usable', () => {
        expect(getImageFormatFromFile({ name: 'noext', type: '' })).toBe('');
        expect(getImageFormatFromFile({ name: 'trailing.', type: '' })).toBe('');
    });
});

describe('imageUtils — formatFileSize', () => {
    it('formats bytes', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(512)).toBe('512 B');
    });

    it('formats KB / MB / GB / TB with one decimal', () => {
        expect(formatFileSize(1024)).toBe('1.0 KB');
        expect(formatFileSize(1536)).toBe('1.5 KB');
        expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
        expect(formatFileSize(1.4 * 1024 * 1024)).toBe('1.4 MB');
        expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
        expect(formatFileSize(1024 ** 4)).toBe('1.0 TB');
    });

    it('returns "--" for invalid input', () => {
        expect(formatFileSize(Number.NaN)).toBe('--');
        expect(formatFileSize(-1)).toBe('--');
        expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('--');
    });
});
