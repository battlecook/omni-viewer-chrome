import {
    PageOrderState,
    deletePage,
    deletedPageNumbers,
    isModified,
    reorder,
    resetOrder
} from '../templates/pdf/js/pageOrder';

describe('pageOrder.resetOrder', () => {
    it('returns the identity order for a 5-page document', () => {
        const s = resetOrder(5);
        expect(s.numPages).toBe(5);
        expect(s.order).toEqual([1, 2, 3, 4, 5]);
    });

    it('handles a 0-page document gracefully', () => {
        const s = resetOrder(0);
        expect(s.numPages).toBe(0);
        expect(s.order).toEqual([]);
    });

    it('floors fractional page counts and clamps negatives', () => {
        const a = resetOrder(3.7);
        expect(a.order).toEqual([1, 2, 3]);
        const b = resetOrder(-4);
        expect(b.order).toEqual([]);
        expect(b.numPages).toBe(0);
    });
});

describe('pageOrder.isModified', () => {
    it('is false for the identity state', () => {
        expect(isModified(resetOrder(7))).toBe(false);
    });

    it('is true after a reorder', () => {
        const s = reorder(resetOrder(7), 0, 3);
        expect(isModified(s)).toBe(true);
    });

    it('is true after a delete', () => {
        const s = deletePage(resetOrder(7), 2);
        expect(isModified(s)).toBe(true);
    });

    it('is false for an empty document', () => {
        expect(isModified(resetOrder(0))).toBe(false);
    });
});

describe('pageOrder.reorder', () => {
    const base = resetOrder(5); // [1, 2, 3, 4, 5]

    it('moves an entry forward', () => {
        const s = reorder(base, 0, 2);
        expect(s.order).toEqual([2, 3, 1, 4, 5]);
    });

    it('moves an entry backward', () => {
        const s = reorder(base, 4, 1);
        expect(s.order).toEqual([1, 5, 2, 3, 4]);
    });

    it('returns a new reference on success', () => {
        const s = reorder(base, 0, 1);
        expect(s).not.toBe(base);
        expect(s.order).not.toBe(base.order);
    });

    it('returns the same reference when fromIdx === toIdx', () => {
        const s = reorder(base, 2, 2);
        expect(s).toBe(base);
    });

    it('returns the same reference for out-of-range indices', () => {
        expect(reorder(base, -1, 0)).toBe(base);
        expect(reorder(base, 0, 5)).toBe(base);
        expect(reorder(base, 5, 0)).toBe(base);
    });

    it('rejects non-integer indices', () => {
        expect(reorder(base, 1.5, 2)).toBe(base);
        expect(reorder(base, 0, Number.NaN)).toBe(base);
    });

    it('preserves numPages when reordering', () => {
        const s = reorder(base, 0, 4);
        expect(s.numPages).toBe(5);
    });

    it('does not mutate the input state', () => {
        const before = base.order.slice();
        reorder(base, 0, 4);
        expect(base.order).toEqual(before);
    });

    it('round-trip identity reorders restore identity', () => {
        const s1 = reorder(base, 0, 4);
        const s2 = reorder(s1, 4, 0);
        expect(s2.order).toEqual([1, 2, 3, 4, 5]);
        expect(isModified(s2)).toBe(false);
    });
});

describe('pageOrder.deletePage', () => {
    const base = resetOrder(4); // [1, 2, 3, 4]

    it('removes the targeted entry', () => {
        const s = deletePage(base, 1);
        expect(s.order).toEqual([1, 3, 4]);
        expect(s.numPages).toBe(4); // numPages unchanged (original PDF preserved)
    });

    it('returns a new reference on success', () => {
        const s = deletePage(base, 0);
        expect(s).not.toBe(base);
    });

    it('refuses to delete the last remaining page', () => {
        const single = resetOrder(1);
        const out = deletePage(single, 0);
        expect(out).toBe(single);
        expect(out.order).toEqual([1]);
    });

    it('refuses to delete from an empty state', () => {
        const empty = resetOrder(0);
        expect(deletePage(empty, 0)).toBe(empty);
    });

    it('returns the same reference for out-of-range indices', () => {
        expect(deletePage(base, -1)).toBe(base);
        expect(deletePage(base, 4)).toBe(base);
    });

    it('rejects non-integer indices', () => {
        expect(deletePage(base, 1.5)).toBe(base);
        expect(deletePage(base, Number.NaN)).toBe(base);
    });

    it('does not mutate the input state', () => {
        const before = base.order.slice();
        deletePage(base, 2);
        expect(base.order).toEqual(before);
    });
});

describe('pageOrder.deletedPageNumbers', () => {
    it('reports empty when nothing has been deleted', () => {
        expect(deletedPageNumbers(resetOrder(3))).toEqual([]);
    });

    it('reports the missing page numbers', () => {
        const s = deletePage(deletePage(resetOrder(5), 2), 0);
        // After deleting index 2 (page 3) → [1,2,4,5]
        // Then deleting index 0 (page 1) → [2,4,5]
        expect(s.order).toEqual([2, 4, 5]);
        expect(deletedPageNumbers(s).sort()).toEqual([1, 3]);
    });

    it('still reports correctly after a reorder + delete combo', () => {
        let s: PageOrderState = resetOrder(4);
        s = reorder(s, 0, 3); // [2,3,4,1]
        s = deletePage(s, 1); // remove page 3 → [2,4,1]
        expect(s.order).toEqual([2, 4, 1]);
        expect(deletedPageNumbers(s)).toEqual([3]);
    });
});

describe('pageOrder reversibility (DoD)', () => {
    it('resetOrder restores identity after arbitrary mutations', () => {
        let s: PageOrderState = resetOrder(6);
        s = reorder(s, 0, 5);
        s = deletePage(s, 2);
        s = reorder(s, 1, 3);
        expect(isModified(s)).toBe(true);
        const reset = resetOrder(s.numPages);
        expect(reset.order).toEqual([1, 2, 3, 4, 5, 6]);
        expect(isModified(reset)).toBe(false);
    });
});
