// Tests for the pure JSON tree reducer (issue #62).
//
// We stay DOM-free: the orchestrator (`jsonViewerMain.ts`) is the half
// that owns DOM. These tests cover:
//
//   - tree shape from `buildTree` (kinds, primitive stringification,
//     parent back-references, ordering of object keys / array indices).
//   - `expand` / `collapse` / `toggle` (no-op on primitives).
//   - `expandAncestorsOf` (auto-expand parents, return changed set).
//   - `clearMatches` resets every node.
//   - `search` matches keys + primitives case-insensitively, returns
//     matches in DFS order, and clears stale matches when re-run.
//   - `nextMatchIndex` / `prevMatchIndex` wrap correctly.

import {
    buildTree,
    collapse,
    expand,
    expandAncestorsOf,
    isContainer,
    nextMatchIndex,
    prevMatchIndex,
    search,
    toggle,
    walk
} from '../templates/json/js/jsonTree';

describe('buildTree — shape', () => {
    it('builds a primitive root for a primitive value', () => {
        const root = buildTree(42);
        expect(root.kind).toBe('number');
        expect(root.primitive).toBe('42');
        expect(root.children).toBeUndefined();
        expect(root.parent).toBeNull();
        expect(root.path).toEqual([]);
        expect(root.key).toBe('$');
    });

    it('honours rootKey option', () => {
        const root = buildTree({}, { rootKey: 'root' });
        expect(root.key).toBe('root');
    });

    it('detects null distinctly from object', () => {
        expect(buildTree(null).kind).toBe('null');
        expect(buildTree(null).primitive).toBe('null');
    });

    it('detects array kind for arrays', () => {
        const root = buildTree([1, 2, 3]);
        expect(root.kind).toBe('array');
        expect(root.children).toHaveLength(3);
        expect(root.children!.map((c) => c.key)).toEqual(['0', '1', '2']);
        expect(root.children!.map((c) => c.path[c.path.length - 1])).toEqual([0, 1, 2]);
    });

    it('preserves object key insertion order', () => {
        const root = buildTree({ b: 1, a: 2, c: 3 });
        expect(root.children!.map((c) => c.key)).toEqual(['b', 'a', 'c']);
    });

    it('stringifies primitives correctly', () => {
        const root = buildTree({ s: 'hi', n: 1.5, b: true, z: null });
        const byKey = Object.fromEntries(
            root.children!.map((c) => [c.key, c.primitive])
        );
        expect(byKey.s).toBe('"hi"');
        expect(byKey.n).toBe('1.5');
        expect(byKey.b).toBe('true');
        expect(byKey.z).toBe('null');
    });

    it('records the path from root for every descendant', () => {
        const root = buildTree({ a: { b: [10, 20] } });
        const innerArrayChild0 = root.children![0].children![0].children![0];
        expect(innerArrayChild0.path).toEqual(['a', 'b', 0]);
        expect(innerArrayChild0.primitive).toBe('10');
    });

    it('wires parent back-references for every node', () => {
        const root = buildTree({ a: { b: 1 } });
        const a = root.children![0];
        const b = a.children![0];
        expect(a.parent).toBe(root);
        expect(b.parent).toBe(a);
        expect(root.parent).toBeNull();
    });

    it('expands the root by default and collapses inner containers', () => {
        const root = buildTree({ a: { b: 1 } });
        expect(root.expanded).toBe(true);
        const a = root.children![0];
        expect(a.expanded).toBe(false);
    });

    it('honours expandRoot=false', () => {
        const root = buildTree({}, { expandRoot: false });
        expect(root.expanded).toBe(false);
    });
});

describe('expand / collapse / toggle', () => {
    it('expand is a no-op for primitives', () => {
        const leaf = buildTree(1, { expandRoot: false });
        expand(leaf);
        // Primitives ignore expand; flag stays at its build-time value.
        expect(leaf.expanded).toBe(false);
    });

    it('collapse is a no-op for primitives', () => {
        const leaf = buildTree(1, { expandRoot: true });
        collapse(leaf);
        // Primitives ignore collapse; flag stays at its build-time value.
        expect(leaf.expanded).toBe(true);
    });

    it('expand sets a container expanded', () => {
        const root = buildTree({ a: 1 }, { expandRoot: false });
        expect(root.expanded).toBe(false);
        expand(root);
        expect(root.expanded).toBe(true);
    });

    it('toggle flips containers and returns new state', () => {
        const root = buildTree({ a: 1 });
        const wasExpanded = root.expanded;
        const next = toggle(root);
        expect(next).toBe(!wasExpanded);
        expect(root.expanded).toBe(next);
    });

    it('toggle is a no-op for primitives', () => {
        const leaf = buildTree('x', { expandRoot: false });
        const before = leaf.expanded;
        const result = toggle(leaf);
        // Primitives ignore toggle; flag stays at the original value.
        expect(result).toBe(before);
        expect(leaf.expanded).toBe(before);
    });

    it('isContainer is true only for objects/arrays', () => {
        expect(isContainer(buildTree({}))).toBe(true);
        expect(isContainer(buildTree([]))).toBe(true);
        expect(isContainer(buildTree('x'))).toBe(false);
        expect(isContainer(buildTree(1))).toBe(false);
        expect(isContainer(buildTree(null))).toBe(false);
        expect(isContainer(buildTree(true))).toBe(false);
    });
});

describe('expandAncestorsOf', () => {
    it('expands every container on the path from root to each match', () => {
        const root = buildTree({
            a: { b: { c: 'leaf' } }
        });
        // After build, only the root is expanded.
        const a = root.children![0];
        const b = a.children![0];
        const c = b.children![0];
        expect(a.expanded).toBe(false);
        expect(b.expanded).toBe(false);

        const changed = expandAncestorsOf([c]);
        expect(a.expanded).toBe(true);
        expect(b.expanded).toBe(true);
        // Root was already expanded.
        expect(root.expanded).toBe(true);
        // Match itself is NOT auto-expanded.
        expect(c.expanded).toBe(false);
        // `changed` includes only the containers whose state actually flipped.
        expect(changed.has(a)).toBe(true);
        expect(changed.has(b)).toBe(true);
        expect(changed.has(root)).toBe(false);
        expect(changed.has(c)).toBe(false);
    });

    it('handles multiple matches sharing ancestors', () => {
        const root = buildTree({
            a: { b: 'one', c: 'two' }
        });
        const a = root.children![0];
        const b = a.children![0];
        const c = a.children![1];
        const changed = expandAncestorsOf([b, c]);
        expect(a.expanded).toBe(true);
        // The shared ancestor a was flipped exactly once.
        expect(Array.from(changed)).toContain(a);
    });

    it('is a no-op when matches are empty', () => {
        const root = buildTree({ a: { b: 1 } });
        const a = root.children![0];
        const changed = expandAncestorsOf([]);
        expect(a.expanded).toBe(false);
        expect(changed.size).toBe(0);
    });
});

describe('search', () => {
    const sample = {
        users: [
            { name: 'Alice', age: 30 },
            { name: 'Bob', age: 25 }
        ],
        meta: { source: 'alice-import' }
    };

    it('returns empty matches for an empty query', () => {
        const root = buildTree(sample);
        const result = search(root, '');
        expect(result.query).toBe('');
        expect(result.matches).toEqual([]);
    });

    it('treats whitespace-only as empty', () => {
        const root = buildTree(sample);
        const result = search(root, '   ');
        expect(result.query).toBe('');
        expect(result.matches).toEqual([]);
    });

    it('matches keys case-insensitively', () => {
        const root = buildTree(sample);
        const result = search(root, 'NAME');
        // Two `name` keys in the array, plus zero key matches elsewhere.
        const matchedKeys = result.matches.map((n) => n.key);
        expect(matchedKeys).toEqual(['name', 'name']);
    });

    it('matches primitive values case-insensitively', () => {
        const root = buildTree(sample);
        const result = search(root, 'alice');
        // Alice (string value) + alice-import (substring inside another value).
        const primitives = result.matches.map((n) => n.primitive);
        expect(primitives).toContain('"Alice"');
        expect(primitives).toContain('"alice-import"');
    });

    it('does NOT match container summaries (only keys + primitives)', () => {
        const root = buildTree({ array: [1, 2, 3] });
        // The legacy renderer used to print "array" type tags; the new
        // viewer only matches the JSON shape, not the synthesized
        // "Array(3)" summary string.
        const result = search(root, 'array(3)');
        expect(result.matches).toEqual([]);
    });

    it('returns matches in depth-first traversal order', () => {
        const root = buildTree({
            a: { x: 'find-me' },
            b: 'find-me',
            c: { d: 'find-me' }
        });
        const result = search(root, 'find-me');
        // DFS order: a.x -> b -> c.d
        const paths = result.matches.map((n) => n.path.join('.'));
        expect(paths).toEqual(['a.x', 'b', 'c.d']);
    });

    it('clears stale matches when re-run', () => {
        const root = buildTree(sample);
        const first = search(root, 'alice');
        expect(first.matches.length).toBeGreaterThan(0);
        for (const m of first.matches) expect(m.matched).toBe(true);

        const second = search(root, 'bob');
        // Old matches should have their `matched` flag cleared.
        for (const m of first.matches) expect(m.matched).toBe(false);
        // New matches should be flagged.
        for (const m of second.matches) expect(m.matched).toBe(true);
    });

    it('clears all matches on empty query', () => {
        const root = buildTree(sample);
        search(root, 'alice');
        search(root, '');
        let anyStillMatched = false;
        walk(root, (n) => {
            if (n.matched) anyStillMatched = true;
        });
        expect(anyStillMatched).toBe(false);
    });

    it('works hand-in-hand with expandAncestorsOf', () => {
        const root = buildTree({
            a: { b: { c: { target: 'hit' } } }
        });
        const a = root.children![0];
        const b = a.children![0];
        const c = b.children![0];
        // Pre-search: only the root is expanded.
        expect(a.expanded).toBe(false);
        expect(b.expanded).toBe(false);
        expect(c.expanded).toBe(false);

        const result = search(root, 'hit');
        expect(result.matches).toHaveLength(1);
        expandAncestorsOf(result.matches);

        // Every ancestor of the match must now be expanded.
        expect(a.expanded).toBe(true);
        expect(b.expanded).toBe(true);
        expect(c.expanded).toBe(true);
    });
});

describe('nextMatchIndex / prevMatchIndex', () => {
    it('returns -1 when there are no matches', () => {
        expect(nextMatchIndex(-1, 0)).toBe(-1);
        expect(prevMatchIndex(-1, 0)).toBe(-1);
        expect(nextMatchIndex(5, 0)).toBe(-1);
    });

    it('starts at 0 / last when current is -1', () => {
        expect(nextMatchIndex(-1, 3)).toBe(0);
        expect(prevMatchIndex(-1, 3)).toBe(2);
    });

    it('wraps forward at the end', () => {
        expect(nextMatchIndex(2, 3)).toBe(0);
    });

    it('wraps backward at the start', () => {
        expect(prevMatchIndex(0, 3)).toBe(2);
    });

    it('advances normally in the middle', () => {
        expect(nextMatchIndex(1, 5)).toBe(2);
        expect(prevMatchIndex(3, 5)).toBe(2);
    });
});

describe('integration — deep-tree perf shape', () => {
    // Build a depth-5+ structure and confirm every node has the expected
    // shape. We don't render here — we just assert the reducer doesn't
    // explode on realistic input.
    function makeDeepTree(depth: number): unknown {
        if (depth === 0) return { leaf: 'value' };
        return {
            level: depth,
            children: [makeDeepTree(depth - 1), makeDeepTree(depth - 1)]
        };
    }

    it('builds a depth-5 tree and finds matches across it', () => {
        const root = buildTree(makeDeepTree(5));
        const result = search(root, 'value');
        // 2^5 leaves, each with key "leaf" and primitive '"value"'.
        expect(result.matches.length).toBe(32);

        // Auto-expand all ancestors and ensure no error / stack overflow.
        const changed = expandAncestorsOf(result.matches);
        // Every ancestor on every path got flipped to expanded — there
        // should be at least `depth` containers per branch that changed.
        expect(changed.size).toBeGreaterThan(0);
    });
});
