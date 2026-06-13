import {
    THUMB_SLOT_HEIGHT_PX,
    THUMB_TARGET_WIDTH_PX,
    THUMB_VIRTUAL_BUFFER,
    computeVisibleWindow
} from '../templates/pdf/js/thumbnail';

describe('computeVisibleWindow', () => {
    const slotHeight = 140;
    const viewportHeight = 700;

    it('returns the empty window for a 0-page document', () => {
        const w = computeVisibleWindow({
            scrollTop: 0,
            viewportHeight,
            slotHeight,
            totalCount: 0
        });
        expect(w.endIndex).toBeLessThan(w.startIndex); // empty
    });

    it('mounts everything for a single-page doc', () => {
        const w = computeVisibleWindow({
            scrollTop: 0,
            viewportHeight,
            slotHeight,
            totalCount: 1
        });
        expect(w.startIndex).toBe(0);
        expect(w.endIndex).toBe(0);
    });

    it('clamps to [0, totalCount-1] at the top of the list', () => {
        const w = computeVisibleWindow({
            scrollTop: 0,
            viewportHeight,
            slotHeight,
            totalCount: 200,
            buffer: 2
        });
        expect(w.startIndex).toBe(0);
        // 700 / 140 = 5 last visible, +2 buffer = 7
        expect(w.endIndex).toBe(7);
    });

    it('clamps to totalCount-1 at the bottom of the list', () => {
        // 200 pages, total height 28000, scroll near bottom.
        const w = computeVisibleWindow({
            scrollTop: 27300,
            viewportHeight,
            slotHeight,
            totalCount: 200,
            buffer: 2
        });
        expect(w.endIndex).toBe(199);
    });

    it('window stays bounded by buffer regardless of total count', () => {
        const w = computeVisibleWindow({
            scrollTop: 14000,
            viewportHeight,
            slotHeight,
            totalCount: 1000,
            buffer: 2
        });
        // visible rows = 5 (700/140). 1st visible idx = 100 (14000/140).
        // last visible idx = 105 ((14000+700)/140). +-2 buffer.
        expect(w.startIndex).toBe(98);
        expect(w.endIndex).toBe(107);
        expect(w.endIndex - w.startIndex + 1).toBe(10); // bounded
    });

    it('handles negative scrollTop (treats as 0)', () => {
        const w = computeVisibleWindow({
            scrollTop: -50,
            viewportHeight,
            slotHeight,
            totalCount: 100
        });
        expect(w.startIndex).toBe(0);
    });

    it('returns empty window when slotHeight is 0', () => {
        const w = computeVisibleWindow({
            scrollTop: 0,
            viewportHeight,
            slotHeight: 0,
            totalCount: 50
        });
        expect(w.endIndex).toBeLessThan(w.startIndex);
    });

    it('honors a custom buffer of 0', () => {
        const w = computeVisibleWindow({
            scrollTop: 0,
            viewportHeight,
            slotHeight,
            totalCount: 200,
            buffer: 0
        });
        expect(w.startIndex).toBe(0);
        expect(w.endIndex).toBe(5); // 700 / 140 = 5 last visible exactly
    });

    it('honors a large buffer (window can extend past visible range)', () => {
        const w = computeVisibleWindow({
            scrollTop: 1400, // index 10 first visible
            viewportHeight,
            slotHeight,
            totalCount: 200,
            buffer: 10
        });
        expect(w.startIndex).toBe(0); // clamped via buffer
        expect(w.endIndex).toBe(25); // 10 .. 15 + 10 buffer
    });
});

describe('thumbnail constants', () => {
    it('exposes the documented slot height + width + buffer', () => {
        expect(THUMB_SLOT_HEIGHT_PX).toBeGreaterThan(0);
        expect(THUMB_TARGET_WIDTH_PX).toBeGreaterThan(0);
        expect(THUMB_VIRTUAL_BUFFER).toBeGreaterThanOrEqual(1);
    });
});
