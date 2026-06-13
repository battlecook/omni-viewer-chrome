// Unit tests for the pure visibility reducer (issue #51).
//
// Coverage:
//   - `walkLayers` flattens an ag-psd children tree in panel order
//     and assigns stable path ids ("0/2/1") + correct depths +
//     `isGroup` / `hasPixels` flags.
//   - `buildInitialVisibility` honors the ag-psd `hidden` flag.
//   - `effectiveVisibility` is true iff every ancestor (inclusive)
//     is visible — short-circuits on the first hidden ancestor.
//   - `toggleVisibility` flips a single node and is non-mutating.
//   - `propagateGroupToggle` cascades the new state to every
//     descendant via the path-prefix relation.
//   - `selectVisibleLeavesInDrawOrder` skips groups + nodes without
//     pixel data + nodes whose ancestors are hidden, and returns
//     them in PSD draw order (bottom-to-top).
//
// These helpers are pure — no DOM, no ag-psd. The DOM-driven
// orchestration in `psdViewerMain.ts` is exercised via manual QA
// per the issue DoD ("visibility change re-renders the canvas
// correctly"); the math here is the part that needs to stay
// pinned.

import {
    LayerNode,
    RawAgPsdLayer,
    buildInitialVisibility,
    effectiveVisibility,
    isNodeVisible,
    propagateGroupToggle,
    selectVisibleLeavesInDrawOrder,
    toggleVisibility,
    walkLayers
} from '../templates/psd/js/psdLayers';

/**
 * Stand-in HTMLCanvasElement for tests. The reducer only checks
 * truthiness on `canvas` to set `hasPixels` and the "select draw
 * list" path passes the canvas through to the caller — it never
 * inspects pixels — so a plain object is sufficient.
 */
const fakeCanvas = (): HTMLCanvasElement =>
    ({ __fake: true } as unknown as HTMLCanvasElement);

/**
 * Build a synthetic PSD tree with two top-level groups, one nested
 * group, and a sprinkling of leaves with / without pixel data.
 *
 *   root
 *   ├─ Group A (0)              hidden=false
 *   │  ├─ Leaf A1 (0/0)         pixels
 *   │  └─ Subgroup A2 (0/1)
 *   │     ├─ Leaf A2a (0/1/0)   pixels, hidden=true (initially)
 *   │     └─ Leaf A2b (0/1/1)   pixels
 *   ├─ Group B (1)              hidden=true (initially)
 *   │  └─ Leaf B1 (1/0)         pixels
 *   └─ Leaf C (2)               pixels (top-level leaf)
 */
const buildSampleTree = (): RawAgPsdLayer[] => [
    {
        name: 'Group A',
        children: [
            { name: 'Leaf A1', canvas: fakeCanvas(), left: 10, top: 20 },
            {
                name: 'Subgroup A2',
                children: [
                    {
                        name: 'Leaf A2a',
                        canvas: fakeCanvas(),
                        hidden: true,
                        left: 5,
                        top: 5
                    },
                    {
                        name: 'Leaf A2b',
                        canvas: fakeCanvas(),
                        left: 0,
                        top: 0
                    }
                ]
            }
        ]
    },
    {
        name: 'Group B',
        hidden: true,
        children: [{ name: 'Leaf B1', canvas: fakeCanvas() }]
    },
    { name: 'Leaf C', canvas: fakeCanvas(), left: 100, top: 50 }
];

describe('walkLayers', () => {
    it('returns an empty array for missing / empty input', () => {
        expect(walkLayers(undefined)).toEqual([]);
        expect(walkLayers([])).toEqual([]);
    });

    it('flattens the tree in panel order with stable paths', () => {
        const flat = walkLayers(buildSampleTree());
        expect(flat.map((n) => n.path)).toEqual([
            '0',
            '0/0',
            '0/1',
            '0/1/0',
            '0/1/1',
            '1',
            '1/0',
            '2'
        ]);
    });

    it('records correct depths', () => {
        const flat = walkLayers(buildSampleTree());
        const byPath = Object.fromEntries(flat.map((n) => [n.path, n]));
        expect(byPath['0'].depth).toBe(0);
        expect(byPath['0/0'].depth).toBe(1);
        expect(byPath['0/1'].depth).toBe(1);
        expect(byPath['0/1/0'].depth).toBe(2);
        expect(byPath['2'].depth).toBe(0);
    });

    it('flags groups vs leaves and pixel availability', () => {
        const flat = walkLayers(buildSampleTree());
        const byPath = Object.fromEntries(flat.map((n) => [n.path, n]));
        expect(byPath['0'].isGroup).toBe(true);
        expect(byPath['0'].hasPixels).toBe(false);
        expect(byPath['0/0'].isGroup).toBe(false);
        expect(byPath['0/0'].hasPixels).toBe(true);
        expect(byPath['0/1'].isGroup).toBe(true);
        expect(byPath['1/0'].isGroup).toBe(false);
        expect(byPath['1/0'].hasPixels).toBe(true);
    });

    it('falls back to a generated name when ag-psd surfaces no name', () => {
        const flat = walkLayers([
            { canvas: fakeCanvas() },
            { name: '   ', canvas: fakeCanvas() }
        ]);
        expect(flat[0].name).toBe('Layer 1');
        expect(flat[1].name).toBe('Layer 2');
    });
});

describe('buildInitialVisibility', () => {
    it('sets each path to !hidden from the ag-psd raw layer', () => {
        const flat = walkLayers(buildSampleTree());
        const map = buildInitialVisibility(flat);
        expect(map['0']).toBe(true); // Group A
        expect(map['0/0']).toBe(true); // Leaf A1
        expect(map['0/1/0']).toBe(false); // Leaf A2a (hidden)
        expect(map['1']).toBe(false); // Group B (hidden)
        expect(map['1/0']).toBe(true); // Leaf B1 (own flag default)
        expect(map['2']).toBe(true); // Leaf C
    });
});

describe('isNodeVisible', () => {
    it('treats unknown paths as visible (lazy-init contract)', () => {
        expect(isNodeVisible({}, '0/0')).toBe(true);
    });

    it('returns the explicit value when present', () => {
        expect(isNodeVisible({ '0/0': false }, '0/0')).toBe(false);
        expect(isNodeVisible({ '0/0': true }, '0/0')).toBe(true);
    });
});

describe('effectiveVisibility', () => {
    it('is true when every ancestor (inclusive) is visible', () => {
        const map = { '0': true, '0/1': true, '0/1/1': true };
        expect(effectiveVisibility(map, '0/1/1')).toBe(true);
    });

    it('is false when ANY ancestor is hidden, even if leaf is visible', () => {
        const map = { '0': true, '0/1': false, '0/1/1': true };
        expect(effectiveVisibility(map, '0/1/1')).toBe(false);
    });

    it('is false when the top-level group is hidden', () => {
        const map = { '0': false, '0/1': true, '0/1/1': true };
        expect(effectiveVisibility(map, '0/1/1')).toBe(false);
    });

    it('is false when the leaf itself is hidden', () => {
        const map = { '0': true, '0/1': true, '0/1/1': false };
        expect(effectiveVisibility(map, '0/1/1')).toBe(false);
    });

    it('treats missing entries as visible', () => {
        expect(effectiveVisibility({}, '0/1/1')).toBe(true);
    });

    it('returns true for empty path (defensive)', () => {
        expect(effectiveVisibility({}, '')).toBe(true);
    });
});

describe('toggleVisibility', () => {
    it('flips a single node from visible to hidden', () => {
        const map = { '0/0': true };
        const next = toggleVisibility(map, '0/0');
        expect(next['0/0']).toBe(false);
    });

    it('flips a missing entry (treated as visible) to hidden', () => {
        const next = toggleVisibility({}, '0/0');
        expect(next['0/0']).toBe(false);
    });

    it('does not mutate the input map', () => {
        const map = { '0/0': true };
        const next = toggleVisibility(map, '0/0');
        expect(map['0/0']).toBe(true);
        expect(next).not.toBe(map);
    });

    it('does not cascade to children', () => {
        const map = { '0': true, '0/0': true };
        const next = toggleVisibility(map, '0');
        expect(next['0']).toBe(false);
        expect(next['0/0']).toBe(true); // child still set to its own value
    });
});

describe('propagateGroupToggle', () => {
    it('flips the group AND every descendant to the new value', () => {
        const layers = walkLayers(buildSampleTree());
        const map = buildInitialVisibility(layers);
        // Start state: Group A and its children all visible (except A2a hidden).
        const next = propagateGroupToggle(layers, map, '0');
        expect(next['0']).toBe(false);
        expect(next['0/0']).toBe(false);
        expect(next['0/1']).toBe(false);
        expect(next['0/1/0']).toBe(false);
        expect(next['0/1/1']).toBe(false);
        // Siblings outside the group are untouched.
        expect(next['1']).toBe(map['1']);
        expect(next['2']).toBe(map['2']);
    });

    it('flips a hidden group ON and re-shows every descendant', () => {
        const layers = walkLayers(buildSampleTree());
        const map = buildInitialVisibility(layers);
        const next = propagateGroupToggle(layers, map, '1');
        expect(next['1']).toBe(true);
        expect(next['1/0']).toBe(true);
    });

    it('only matches descendants on the path-prefix boundary', () => {
        // Path "1" must NOT match "10" / "11" if the tree had 11+
        // siblings — verify with a synthetic flat list.
        const layers: LayerNode[] = [
            {
                path: '1',
                index: 1,
                depth: 0,
                name: 'g',
                isGroup: true,
                hasPixels: false,
                raw: {}
            },
            {
                path: '10',
                index: 10,
                depth: 0,
                name: 'sib',
                isGroup: false,
                hasPixels: true,
                raw: {}
            },
            {
                path: '1/0',
                index: 0,
                depth: 1,
                name: 'child',
                isGroup: false,
                hasPixels: true,
                raw: {}
            }
        ];
        const next = propagateGroupToggle(layers, {}, '1');
        expect(next['1']).toBe(false);
        expect(next['1/0']).toBe(false);
        expect(next['10']).toBeUndefined(); // not touched
    });

    it('does not mutate the input map', () => {
        const layers = walkLayers(buildSampleTree());
        const map = buildInitialVisibility(layers);
        const snapshot = JSON.parse(JSON.stringify(map));
        propagateGroupToggle(layers, map, '0');
        expect(map).toEqual(snapshot);
    });

    it('still flips a non-group node (no descendants) — caller need not check', () => {
        const layers = walkLayers(buildSampleTree());
        const map = buildInitialVisibility(layers);
        const next = propagateGroupToggle(layers, map, '2');
        expect(next['2']).toBe(false);
    });
});

describe('selectVisibleLeavesInDrawOrder', () => {
    it('returns leaves bottom-to-top (reverse of panel order)', () => {
        const layers = walkLayers(buildSampleTree());
        // Force every node visible so the only filter is "leaf with pixels".
        const map: Record<string, boolean> = {};
        for (const n of layers) map[n.path] = true;
        const draw = selectVisibleLeavesInDrawOrder(layers, map);
        expect(draw.map((n) => n.path)).toEqual([
            '2',
            '1/0',
            '0/1/1',
            '0/1/0',
            '0/0'
        ]);
    });

    it('skips groups, hidden ancestors, and leaves without pixels', () => {
        const layers = walkLayers([
            {
                name: 'Visible group',
                children: [
                    { name: 'Pixel leaf', canvas: fakeCanvas() },
                    { name: 'No-pixel leaf' } // dropped — no canvas/imageData
                ]
            },
            {
                name: 'Hidden group',
                children: [{ name: 'Buried leaf', canvas: fakeCanvas() }]
            }
        ]);
        const map: Record<string, boolean> = {
            '0': true,
            '0/0': true,
            '0/1': true,
            '1': false, // hidden group
            '1/0': true // own flag is true but ancestor "1" is hidden
        };
        const draw = selectVisibleLeavesInDrawOrder(layers, map);
        expect(draw.map((n) => n.path)).toEqual(['0/0']);
    });

    it('skips a leaf whose own flag is false', () => {
        const layers = walkLayers([
            { name: 'L1', canvas: fakeCanvas() },
            { name: 'L2', canvas: fakeCanvas() }
        ]);
        const draw = selectVisibleLeavesInDrawOrder(layers, {
            '0': true,
            '1': false
        });
        expect(draw.map((n) => n.path)).toEqual(['0']);
    });
});
